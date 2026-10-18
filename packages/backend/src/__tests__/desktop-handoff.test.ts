import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopUrl, mintDesktopCode, redeemDesktopCode, returnToAppPage } from "../auth/desktop-handoff";

afterEach(() => vi.useRealTimers());

describe("desktop sign-in hand-off", () => {
  it("gives the cookies back once", () => {
    const code = mintDesktopCode(["a=1", "b=2"]);
    expect(redeemDesktopCode(code)).toEqual(["a=1", "b=2"]);
    expect(redeemDesktopCode(code)).toBeNull();
  });

  it("refuses unknown and expired codes", () => {
    expect(redeemDesktopCode("nope")).toBeNull();
    expect(redeemDesktopCode(undefined)).toBeNull();
    vi.useFakeTimers();
    const code = mintDesktopCode(["a=1"]);
    vi.advanceTimersByTime(61_000);
    expect(redeemDesktopCode(code)).toBeNull();
  });

  it("sends the browser to the app's scheme", () => {
    const code = mintDesktopCode([]);
    expect(desktopUrl(code)).toBe(`missive://auth?code=${code}`);
    expect(returnToAppPage(code).html).toContain(`missive://auth?code=${code}`);
  });
});
