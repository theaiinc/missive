import { afterEach, describe, expect, it, vi } from "vitest";
import { exitOnSignals } from "../main";

describe("exitOnSignals", () => {
  afterEach(() => {
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    vi.useRealTimers();
  });

  it("closes the app and exits on SIGTERM", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    exitOnSignals(close, exit);
    process.emit("SIGTERM", "SIGTERM");
    await new Promise((r) => setImmediate(r));
    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits anyway when closing hangs", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    exitOnSignals(() => new Promise(() => {}), exit, 5_000);
    process.emit("SIGTERM", "SIGTERM");
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
