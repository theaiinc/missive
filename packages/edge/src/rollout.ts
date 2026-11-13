/**
 * Getting a deploy's API build live. A deploy updates the Worker at once, but
 * the container keeps running its old image, and a container restarted soon
 * after a deploy can come back up on the previous image. So the every-minute
 * cron asks the API which build it is (GET /api/v1/health → build) and
 * restarts it until that's the build this Worker was deployed with
 * (MISSIVE_BUILD, set by the deploy from the same id baked into the image).
 */

/** Kept in the API's Durable Object while the running build isn't the expected one. */
export type RolloutState = { expected: string; since: number; restarts: number; lastRestart: number };

export type RolloutStep = { restart: boolean; state: RolloutState | undefined; stuck: boolean };

/** After this long on the wrong build, every check logs an error (Workers Logs). */
export const STUCK_AFTER_MS = 5 * 60_000;
/** Cron ticks are about a minute apart, give or take a few seconds. */
const TICK_MS = 50_000;
const MAX_WAIT_MS = 10 * 60_000;

/** How long to wait after the nth restart before the next: a minute twice, then doubling, up to 10. */
export function waitAfter(restarts: number): number {
  if (restarts === 0) return 0;
  return Math.min(TICK_MS * 2 ** Math.max(0, restarts - 2), MAX_WAIT_MS);
}

/**
 * What to do on a cron tick, given the build this Worker expects and the one
 * the API reported (null: an API too old to say, so certainly not this one).
 */
export function rolloutStep(state: RolloutState | undefined, expected: string, reported: string | null, now: number): RolloutStep {
  if (reported === expected) return { restart: false, state: undefined, stuck: false };
  const current: RolloutState =
    state?.expected === expected ? state : { expected, since: now, restarts: 0, lastRestart: 0 };
  const stuck = now - current.since >= STUCK_AFTER_MS;
  if (now - current.lastRestart < waitAfter(current.restarts)) return { restart: false, state: current, stuck };
  return { restart: true, state: { ...current, restarts: current.restarts + 1, lastRestart: now }, stuck };
}
