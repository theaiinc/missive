import { describe, expect, it } from "vitest";
import { STUCK_AFTER_MS, rolloutStep, waitAfter, type RolloutState } from "./rollout";

const T0 = 1_800_000_000_000;
const min = 60_000;

describe("rolloutStep", () => {
  it("does nothing once the API reports the expected build", () => {
    const state: RolloutState = { expected: "b2", since: T0, restarts: 2, lastRestart: T0 };
    expect(rolloutStep(state, "b2", "b2", T0 + min)).toEqual({ restart: false, state: undefined, stuck: false });
  });

  it("restarts at once when an older build (or one too old to say) is running", () => {
    for (const reported of ["b1", null]) {
      const step = rolloutStep(undefined, "b2", reported, T0);
      expect(step.restart).toBe(true);
      expect(step.state).toEqual({ expected: "b2", since: T0, restarts: 1, lastRestart: T0 });
    }
  });

  it("restarts again on the next tick when the restart came back on the old image", () => {
    let state = rolloutStep(undefined, "b2", "b1", T0).state;
    // Same tick's follow-up check, or a second cron overlapping: no double restart.
    expect(rolloutStep(state, "b2", "b1", T0 + 5_000).restart).toBe(false);
    const next = rolloutStep(state, "b2", "b1", T0 + 58_000);
    expect(next.restart).toBe(true);
    state = next.state;
    expect(state?.restarts).toBe(2);
  });

  it("backs off when the new image keeps not showing up, and flags it after 5 minutes", () => {
    let state: RolloutState | undefined;
    const restartsAt: number[] = [];
    let stuckAt: number | null = null;
    for (let t = 0; t <= 30 * min; t += min) {
      const step = rolloutStep(state, "b2", "b1", T0 + t);
      if (step.restart) restartsAt.push(t / min);
      if (step.stuck && stuckAt === null) stuckAt = t;
      state = step.state;
    }
    expect(restartsAt.slice(0, 5)).toEqual([0, 1, 2, 4, 8]);
    expect(restartsAt.length).toBeLessThan(10);
    expect(stuckAt).toBe(STUCK_AFTER_MS);
  });

  it("starts over for a newer deploy", () => {
    const old: RolloutState = { expected: "b2", since: T0, restarts: 6, lastRestart: T0 };
    const step = rolloutStep(old, "b3", "b2", T0 + min);
    expect(step.restart).toBe(true);
    expect(step.state).toEqual({ expected: "b3", since: T0 + min, restarts: 1, lastRestart: T0 + min });
  });
});

describe("waitAfter", () => {
  it("caps at 10 minutes", () => {
    expect(waitAfter(0)).toBe(0);
    expect(waitAfter(30)).toBe(10 * min);
  });
});
