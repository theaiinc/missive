import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The file the deploy writes at the repo root before building the image (packages/edge/scripts/stamp-build.mjs). */
export const BUILD_FILE = ".missive-build";

/**
 * Which deploy built this API, or null for a build without one (development).
 * The edge Worker's cron compares it with the build it was deployed with and
 * restarts the container until they match, since Cloudflare can bring a
 * restarted container back up on the previous image.
 */
export function readBuildId(start = __dirname, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.MISSIVE_BUILD) return env.MISSIVE_BUILD;
  for (let dir = start, i = 0; i < 6; i++, dir = dirname(dir)) {
    const file = join(dir, BUILD_FILE);
    if (existsSync(file)) return readFileSync(file, "utf8").trim() || null;
    if (dirname(dir) === dir) break;
  }
  return null;
}

export const BUILD_ID = readBuildId();
