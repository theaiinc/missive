import { describe, expect, it, vi } from "vitest";
import { ClientErrorsController } from "../client-errors.controller";
import { runAsUser } from "../request-context";

describe("client error reports", () => {
  it("keeps a report, ignores empty ones, and caps a loop of them", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const controller = new ClientErrorsController({ query } as never);
    await runAsUser({ id: "u-1", email: "a@b.com" } as never, async () => {
      await controller.report({ kind: "render", message: "TypeError: x is undefined", stack: "at Inbox", page: "/thread/t_1" });
      expect(query).toHaveBeenCalledTimes(1);
      expect((query.mock.calls[0] as unknown[])[1]).toEqual(["render", "TypeError: x is undefined", "at Inbox", null, "/thread/t_1", null]);
      await controller.report({ message: "" });
      expect(query).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 50; i++) await controller.report({ message: "TypeError: again" });
      expect(query).toHaveBeenCalledTimes(30);
    });
  });
});
