/**
 * One-off: encrypts the compose drafts saved before drafts were encrypted
 * (see draft-crypto.ts), in place, in batches. Idempotent: only rows with a
 * column still in the clear (payload a JSON object, or mailbox without the
 * "mv1." prefix) are touched, so it can be stopped and run again. updated_at
 * is left alone, so the drafts list keeps its order.
 *
 *   DATABASE_URL=postgresql://... MISSIVE_DATA_KEY=... pnpm --filter @theaiinc/missive-backend exec tsx src/scripts/encrypt-drafts.ts --dry-run
 *
 * --dry-run prints only counts (drafts in all, already encrypted, to encrypt).
 * Without it, it encrypts and prints how many it did. It works one user at a
 * time as that user, like the app (drafts has FORCE ROW LEVEL SECURITY), so
 * DATABASE_URL is the API's own connection (the one that may SET ROLE
 * missive_app). It needs the production MISSIVE_DATA_KEY: rows encrypted with
 * any other key can't be read by the API.
 */
import { PostgresService } from "../storage/postgres.service";
import { runAsUser } from "../request-context";
import { draftNeedsEncryption, openDraft, sealDraft } from "../draft-crypto";
import { dataCipher } from "../data-cipher";

type Db = Pick<PostgresService, "query" | "systemQuery">;

export const BATCH = 100;

/** A draft with a column still in the clear. */
export const PENDING = `(jsonb_typeof(payload) <> 'string' OR mailbox NOT LIKE 'mv1.%')`;

export type EncryptDraftsResult = { users: number; total: number; encrypted: number; pending: number; done: number };

export async function encryptDrafts(db: Db, { dryRun, batch = BATCH }: { dryRun: boolean; batch?: number }): Promise<EncryptDraftsResult> {
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
            console.error(`Draft ${row.id} could not be read; left as it is.`);
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

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (!process.env.DATABASE_URL) {
    console.error("Set DATABASE_URL to the database whose drafts to encrypt.");
    process.exit(2);
  }
  if (!process.env.MISSIVE_DATA_KEY) {
    console.error("Set MISSIVE_DATA_KEY to the key the API uses.");
    process.exit(2);
  }
  const db = new PostgresService();
  try {
    const r = await encryptDrafts(db, { dryRun });
    console.log(`${r.total} draft(s) across ${r.users} user(s): ${r.encrypted} already encrypted, ${r.pending} in the clear.`);
    if (!dryRun) console.log(`Encrypted ${r.done} draft(s).`);
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    // Only the message: never a row.
    console.error(error instanceof Error ? error.message : "encrypt-drafts failed");
    process.exit(1);
  });
}
