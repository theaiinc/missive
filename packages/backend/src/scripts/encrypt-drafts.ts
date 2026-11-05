/**
 * Encrypts the compose drafts saved before drafts were encrypted (see
 * draft-crypto.ts), in place, in batches. The API's startup backfill does the
 * same on every start (encryption-backfill.service.ts); this is the same
 * conversion (draft-backfill.ts), by hand, e.g. to check counts first. Idempotent: only rows with a
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
import { encryptDrafts } from "../draft-backfill";

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
    const r = await encryptDrafts(db, { dryRun, onSkip: (id) => console.error(`Draft ${id} could not be read; left as it is.`) });
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
