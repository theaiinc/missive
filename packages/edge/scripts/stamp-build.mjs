// Before `wrangler deploy`: writes this deploy's build id to <repo>/.missive-build,
// which the API image copies in (Dockerfile.backend) and reports from GET
// /api/v1/health, and prints it for `wrangler deploy --var MISSIVE_BUILD:…`, so the
// Worker's cron can tell whether the running container is this deploy (src/rollout.ts).
// Unique per deploy (commit + time), so a re-run of the same commit is checked too.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sha = (process.env.GITHUB_SHA || execSync("git rev-parse HEAD", { encoding: "utf8" })).trim().slice(0, 12);
const id = `${sha}-${Date.now().toString(36)}`;
writeFileSync(fileURLToPath(new URL("../../../.missive-build", import.meta.url)), `${id}\n`);
process.stdout.write(id);
