import { PostgresService } from "./storage/postgres.service";
import { runAsUser } from "./request-context";
import { draftNeedsEncryption, openDraft, sealDraft } from "./draft-crypto";
import { dataCipher } from "./data-cipher";

/**
 * Converts compose drafts saved before drafts were encrypted (draft-crypto.ts).
 * Run by the startup backfill (encryption-backfill.service.ts) and by
 * scripts/encrypt-drafts.ts by hand.
 */
type Db = Pick<PostgresService, "query" | "systemQuery">;

export const BATCH = 100;

/** A draft with a column still in the clear. */
export const PENDING = `(jsonb_typeof(payload) <> 'string' OR mailbox NOT LIKE 'mv1.%')`;

export type EncryptDraftsResult = { users: number; total: number; encrypted: number; pending: number; done: number };

/**
 * Encrypts the drafts still (partly) in the clear, one user at a time as that
 * user (drafts has FORCE ROW LEVEL SECURITY), in batches. Idempotent and safe
 * while people edit: a row is rewritten only while it's still pending, so a
 * draft the app has saved meanwhile (encrypted) is never overwritten, and
 * updated_at is left alone. dryRun only counts. `onSkip` hears the id of a
 * row that can't be read (it is left as it is); nothing else of a row leaves.
 */
export async function encryptDrafts(
  db: Db,
  { dryRun, batch = BATCH, onSkip }: { dryRun: boolean; batch?: number; onSkip?: (draftId: string) => void },
): Promise<EncryptDraftsResult> {
  // Fails before touching anything if the key is missing.
  dataCipher();
  const { rows: users } = await db.systemQuery(`SELECT id FROM users ORDER BY id`);
  const result: EncryptDraftsResult = { users: users.length, total: 0, encrypted: 0, pending: 0, done: 0 };
  for (const { id: userId } of users) {
    await runAsUser({ id: userId, email: "" }, async () => {
      const { rows: [counts] } = await db.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE ${PENDING})::int AS pending FROM drafts WHERE owner_id = $1`,
        [userId],
      );
      result.total += counts.total;
      result.pending += counts.pending;
      result.encrypted += counts.total - counts.pending;
      if (dryRun || counts.pending === 0) return;
      // A row that fails to open (it shouldn't: pending rows are plain) is
      // skipped by id, so one bad row can't stop the run or loop it forever.
      const skipped: string[] = [];
      for (;;) {
        const { rows } = await db.query(
          `SELECT id, owner_id, mailbox, payload FROM drafts
            WHERE owner_id = $1 AND ${PENDING} AND NOT (id = ANY($3::uuid[]))
            ORDER BY id LIMIT $2`,
          [userId, batch, skipped],
        );
        if (rows.length === 0) return;
        for (const row of rows) {
          if (!draftNeedsEncryption(row)) continue;
          let sealed;
          try {
            sealed = await sealDraft(row.owner_id, row.id, await openDraft(row));
          } catch {
            skipped.push(row.id);
            onSkip?.(row.id);
            continue;
          }
          // Only while still pending: never overwrite a draft the app has
          // since saved (encrypted) with what was read before that.
          const updated = await db.query(
            `UPDATE drafts SET mailbox = $2, payload = $3::jsonb, is_empty = $4
              WHERE id = $1 AND owner_id = $5 AND ${PENDING}`,
            [row.id, sealed.mailbox, sealed.payload, sealed.isEmpty, row.owner_id],
          );
          result.done += updated.rowCount ?? 0;
        }
      }
    });
  }
  return result;
}
