import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Missive } from "@theaiinc/missive-core";
import { quoted, recipients, replySubject, ReplyError, ReplyService } from "../reply.service";

const requireUser = vi.hoisted(() => vi.fn(() => ({ id: "user-1", email: "owner@gmail.com", name: "Owner" })));
vi.mock("../request-context", () => ({ requireUser }));

const NOW = "2026-11-26T08:00:00.000Z";
const gmailMail = (over: Partial<Missive> = {}): Missive =>
  ({
    id: "g1",
    threadId: "t1",
    channel: "email",
    direction: "inbound",
    provider: "gmail",
    providerMessageId: "g1",
    subject: "Lunch on Friday?",
    body: "Are you free?\nLan",
    from: { address: "lan@example.com", name: "Lan" },
    to: [{ address: "owner@gmail.com" }],
    cc: [{ address: "minh@example.com" }, { address: "owner@theaiinc.com" }],
    bcc: [],
    status: "unread",
    folder: "inbox",
    accountEmail: "owner@gmail.com",
    receivedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }) as Missive;

function setup(original: Missive | null) {
  const storage = { getMissive: vi.fn(async () => original) };
  const gmail = {
    account: vi.fn(async (a: string) => (a === "owner@gmail.com" ? { id: "acc" } : undefined)),
    replyToOf: vi.fn(async () => []),
    send: vi.fn(async () => ({ id: "sent-g", threadId: "t1" })),
  };
  const mail = { send: vi.fn(async () => ({ id: "sent-h", threadId: "t2" })) };
  const groups = {
    addressesOf: vi.fn(async () => [
      { address: "owner@theaiinc.com", kind: "mailbox" },
      { address: "info@theaiinc.com", kind: "group", role: "member" },
    ]),
  };
  return { storage, gmail, mail, groups, service: new ReplyService(storage as never, gmail as never, mail as never, groups as never) };
}

describe("reply addressing", () => {
  it("adds Re: once", () => {
    expect(replySubject("Hi")).toBe("Re: Hi");
    expect(replySubject("RE: Hi")).toBe("RE: Hi");
  });

  it("answers the sender, or Reply-To when it names someone else", () => {
    const own = new Set(["owner@gmail.com"]);
    expect(recipients(gmailMail(), [], own, false)).toEqual({ to: ["lan@example.com"], cc: [] });
    expect(recipients(gmailMail(), [{ address: "Real@Example.com" }], own, false).to).toEqual(["real@example.com"]);
  });

  it("reply-all copies the others but never you", () => {
    const own = new Set(["owner@gmail.com", "owner@theaiinc.com"]);
    expect(recipients(gmailMail(), [], own, true)).toEqual({ to: ["lan@example.com"], cc: ["minh@example.com"] });
  });

  it("a reply to your own sent mail goes to its recipients", () => {
    const sent = gmailMail({ direction: "outbound", from: { address: "owner@gmail.com" }, to: [{ address: "lan@example.com" }] });
    expect(recipients(sent, [], new Set(["owner@gmail.com"]), false).to).toEqual(["lan@example.com"]);
  });

  it("quotes the original under the reply", () => {
    expect(quoted("Yes!", gmailMail())).toMatch(/^Yes!\n\nOn .+, Lan wrote:\n> Are you free\?\n> Lan$/);
  });
});

describe("ReplyService", () => {
  beforeEach(() => requireUser.mockClear());

  it("plans a Gmail reply from the Gmail address it came to", async () => {
    const { service } = setup(gmailMail());
    await expect(service.plan("g1", " Friday works. ")).resolves.toMatchObject({
      route: "gmail", from: "owner@gmail.com", to: ["lan@example.com"], cc: [], subject: "Re: Lunch on Friday?", text: "Friday works.", replyTo: "g1", threadId: "t1",
    });
  });

  it("sends through Gmail, threaded on the original, with the original quoted", async () => {
    const { service, gmail, mail } = setup(gmailMail());
    const sent = await service.send("g1", "Friday works.", false, { from: "owner@gmail.com", to: ["lan@example.com"], subject: "Re: Lunch on Friday?" });
    expect(sent).toMatchObject({ id: "sent-g", threadId: "t1", from: "owner@gmail.com" });
    expect(mail.send).not.toHaveBeenCalled();
    const out = (gmail.send.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(out).toMatchObject({ from: "owner@gmail.com", to: ["lan@example.com"], replyTo: "g1", subject: "Re: Lunch on Friday?" });
    expect(out.text).toMatch(/^Friday works\.\n\nOn .*Lan wrote:/);
  });

  it("sends a hosted mailbox's reply from that mailbox", async () => {
    const { service, gmail, mail } = setup(gmailMail({ provider: "missive", accountEmail: "owner@theaiinc.com", to: [{ address: "owner@theaiinc.com" }], cc: [] }));
    await expect(service.send("g1", "Sure.", false)).resolves.toMatchObject({ route: "missive", from: "owner@theaiinc.com", id: "sent-h" });
    expect(gmail.send).not.toHaveBeenCalled();
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ from: "owner@theaiinc.com", replyTo: "g1" }));
  });

  it("refuses to send when the recipients differ from what was shown", async () => {
    const { service, gmail } = setup(gmailMail());
    await expect(service.send("g1", "Hi", false, { to: ["someone@else.com"] })).rejects.toMatchObject({ status: 409 });
    expect(gmail.send).not.toHaveBeenCalled();
  });

  it("never falls back to another address", async () => {
    const { service } = setup(gmailMail({ accountEmail: "old@gmail.com" }));
    await expect(service.plan("g1", "Hi")).rejects.toThrow(/old@gmail.com isn't connected for sending/);
    const group = setup(gmailMail({ provider: "missive", accountEmail: "info@theaiinc.com" }));
    await expect(group.service.plan("g1", "Hi")).rejects.toThrow(/Only owners and moderators/);
    const outlook = setup(gmailMail({ provider: "outlook" }));
    await expect(outlook.service.plan("g1", "Hi")).rejects.toThrow(/isn't supported yet/);
  });

  it("needs text and a message that exists", async () => {
    await expect(setup(gmailMail()).service.plan("g1", "  ")).rejects.toBeInstanceOf(ReplyError);
    await expect(setup(null).service.plan("nope", "Hi")).rejects.toMatchObject({ status: 404 });
  });
});
