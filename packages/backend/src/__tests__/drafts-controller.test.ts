import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DraftsController } from "../drafts.controller";

const requireUser = vi.hoisted(() => vi.fn(() => ({ id: "user-1" })));

vi.mock("../request-context", () => ({ requireUser }));

const ID = "2f1d3c4b-5a69-4788-9abc-def012345678";

function setup() {
  const drafts = { upsert: vi.fn(), list: vi.fn(), get: vi.fn(), remove: vi.fn() };
  const groups = { addressesOf: vi.fn().mockResolvedValue([{ address: "owned@example.com" }]) };
  const gmail = { account: vi.fn().mockResolvedValue(undefined) };
  const controller = new DraftsController(drafts as never, groups as never, gmail as never);
  return { drafts, groups, gmail, controller };
}

describe("DraftsController draft input validation", () => {
  it("rejects a missing mailbox or payload with HTTP 400", async () => {
    const { controller, groups } = setup();
    await expect(controller.create({ mailbox: "owned@example.com" })).rejects.toBeInstanceOf(BadRequestException);
    expect(groups.addressesOf).not.toHaveBeenCalled();
  });

  it("rejects a mailbox that does not belong to the signed-in user with HTTP 403", async () => {
    const { controller, groups, drafts } = setup();
    await expect(
      controller.create({ mailbox: "other@example.com", payload: { subject: "secret" } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(groups.addressesOf).toHaveBeenCalledWith("user-1");
    expect(drafts.upsert).not.toHaveBeenCalled();
  });

  it("saves from a connected Gmail account the user may send from", async () => {
    const { controller, gmail, drafts } = setup();
    gmail.account.mockResolvedValue({ id: "gmail-1" });
    drafts.get.mockResolvedValue(null);
    drafts.upsert.mockResolvedValue({ id: ID });
    await expect(controller.upsert(ID, { mailbox: "Me@Gmail.com", payload: { to: "a@b.c" } })).resolves.toEqual({ id: ID });
    expect(gmail.account).toHaveBeenCalledWith("me@gmail.com");
    expect(drafts.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: ID, mailbox: "me@gmail.com" }));
  });

  it("never creates an empty draft", async () => {
    const { controller, drafts } = setup();
    drafts.get.mockResolvedValue(null);
    const empty = { mailbox: "owned@example.com", payload: { to: " ", subject: "", html: "<p></p>", text: "-- \nMy signature", attachments: [] } };
    await expect(controller.create(empty)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.upsert(ID, empty)).rejects.toBeInstanceOf(BadRequestException);
    expect(drafts.upsert).not.toHaveBeenCalled();
  });

  it("lets you empty a draft you already have", async () => {
    const { controller, drafts } = setup();
    drafts.get.mockResolvedValue({ id: ID });
    drafts.upsert.mockResolvedValue({ id: ID });
    await controller.upsert(ID, { mailbox: "owned@example.com", payload: { html: "" } });
    expect(drafts.upsert).toHaveBeenCalled();
  });

  it("refuses to overwrite someone else's draft id with HTTP 403", async () => {
    const { controller, drafts } = setup();
    drafts.get.mockResolvedValue(null);
    drafts.upsert.mockResolvedValue(null);
    await expect(controller.upsert(ID, { mailbox: "owned@example.com", payload: { subject: "hi" } })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects an id that isn't a UUID with HTTP 400", async () => {
    const { controller, drafts } = setup();
    await expect(controller.get("1; DROP TABLE drafts")).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.remove("nope")).rejects.toBeInstanceOf(BadRequestException);
    expect(drafts.get).not.toHaveBeenCalled();
    expect(drafts.remove).not.toHaveBeenCalled();
  });
});

describe("DraftsController list, read and delete", () => {
  beforeEach(() => requireUser.mockClear());

  it("lists the signed-in user's drafts", async () => {
    const { controller, drafts } = setup();
    drafts.list.mockResolvedValue([{ id: ID }]);
    await expect(controller.list()).resolves.toEqual([{ id: ID }]);
  });

  it("reads only your own draft", async () => {
    const { controller, drafts } = setup();
    drafts.get.mockResolvedValue(null);
    await expect(controller.get(ID)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("deletes your draft", async () => {
    const { controller, drafts } = setup();
    drafts.remove.mockResolvedValue(true);
    await expect(controller.remove(ID)).resolves.toBeUndefined();
    expect(drafts.remove).toHaveBeenCalledWith(ID);
  });

  it("refuses to delete a draft that isn't yours (or is gone) with HTTP 403", async () => {
    const { controller, drafts } = setup();
    drafts.remove.mockResolvedValue(false);
    await expect(controller.remove(ID)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
