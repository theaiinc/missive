import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { DraftsController } from "../drafts.controller";

const requireUser = vi.hoisted(() => vi.fn(() => ({ id: "user-1" })));

vi.mock("../request-context", () => ({ requireUser }));

describe("DraftsController draft input validation", () => {
  const drafts = { upsert: vi.fn() };
  const groups = { addressesOf: vi.fn() };
  const controller = new DraftsController(drafts as never, groups as never);

  it("rejects a missing mailbox or payload with HTTP 400", async () => {
    await expect(controller.create({ mailbox: "me@example.com" })).rejects.toBeInstanceOf(BadRequestException);
    expect(groups.addressesOf).not.toHaveBeenCalled();
  });

  it("rejects a mailbox that does not belong to the signed-in user with HTTP 403", async () => {
    groups.addressesOf.mockResolvedValue([{ address: "owned@example.com" }]);

    await expect(
      controller.create({ mailbox: "other@example.com", payload: { subject: "secret" } }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(groups.addressesOf).toHaveBeenCalledWith("user-1");
    expect(drafts.upsert).not.toHaveBeenCalled();
  });
});