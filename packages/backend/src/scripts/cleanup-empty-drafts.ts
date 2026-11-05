/**
 * One-off: deletes the empty compose drafts the autosave of #71 created (one
 * each time Compose opened, nothing typed). Empty means isEmptyDraftPayload:
 * no recipients, subject, body or attachment. Only drafts untouched for an
 * hour go, so nothing someone has open right now is removed.
 *
 *   DATABASE_URL=postgresql://... pnpm --filter @theaiinc/missive-backend exec tsx src/scripts/cleanup-empty-drafts.ts --dry-run
 *
 * --dry-run prints only how many it would delete. Without it, it deletes them
 * and prints how many it did. It needs a connection that isn't held to one
 * user's rows (the migrations' connection, as DATABASE_URL in the API).
 */
import { Pool } from "pg";
import { EMPTY_DRAFT_SQL } from "../draft-content";

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

export const STALE_AFTER = "1 hour";

export const COUNT_EMPTY_DRAFTS = `SELECT count(*)::int AS count FROM drafts
 WHERE updated_at < NOW() - $1::interval
   AND ${EMPTY_DRAFT_SQL}`;

export const DELETE_EMPTY_DRAFTS = `DELETE FROM drafts
 WHERE updated_at < NOW() - $1::interval
   AND ${EMPTY_DRAFT_SQL}`;

/** How many empty drafts there are (dryRun) or were deleted. */
export async function cleanupEmptyDrafts(db: Queryable, { dryRun }: { dryRun: boolean }): Promise<number> {
  if (dryRun) {
    const { rows } = await db.query(COUNT_EMPTY_DRAFTS, [STALE_AFTER]);
    return Number(rows[0]?.count ?? 0);
  }
  const result = await db.query(DELETE_EMPTY_DRAFTS, [STALE_AFTER]);
  return result.rowCount ?? 0;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (!process.env.DATABASE_URL) {
    console.error("Set DATABASE_URL to the database to clean.");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const count = await cleanupEmptyDrafts(pool, { dryRun });
    console.log(dryRun ? `${count} empty draft(s) older than ${STALE_AFTER} would be deleted.` : `Deleted ${count} empty draft(s) older than ${STALE_AFTER}.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
