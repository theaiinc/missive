import { Injectable } from "@nestjs/common";
import type { Missive } from "@theaiinc/missive-core";
import { StorageService } from "./storage/storage.service";
import { GmailSendError, GmailSendService } from "./gmail-send.service";
import { MailboxService, SendError } from "./mailbox.service";
import { GroupsService } from "./groups.service";
import { requireUser } from "./request-context";
import { replyRecipients, type Address } from "./addresses";
import { messageBody } from "./message-html";

/**
 * Replies worked out by Missive itself from the message being answered, for
 * assistants (Simasis) that reply on the owner's behalf: they say which
 * message and what to say; Missive picks the From (the address the mail came
 * to, never another one), To (Reply-To, else the sender; your own sent mail
 * goes to its recipients), the "Re:" subject and the threading. The preview
 * is what the owner is shown; the send refuses when it would differ from it.
 */

/** How a reply leaves: through the connected Gmail account, or a hosted mailbox. */
export type ReplyRoute = "gmail" | "missive";

export interface ReplyPlan {
  replyTo: string;
  threadId: string;
  route: ReplyRoute;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  /** What the owner wrote, without the quoted original. */
  text: string;
  /** The original, as quoted below the reply. */
  original: { from: Address; subject: string; receivedAt: string };
}

/** What the owner was shown; the send goes ahead only if it still matches. */
export interface ReplyExpectation {
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
}

export class ReplyError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

const MAX_TEXT = 20_000;
const lower = (a: string) => a.trim().toLowerCase();
const sameSet = (a: string[], b: string[]) => {
  const x = [...new Set(a.map(lower))].sort();
  const y = [...new Set(b.map(lower))].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** "Re: " once, whatever case the original used. */
export const replySubject = (subject: string | undefined) => {
  const s = (subject ?? "").trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`.trim();
};

/** The reply's text with the original quoted under it, as Missive's own Reply does. */
export function quoted(text: string, original: Pick<Missive, "from" | "receivedAt" | "body">): string {
  const who = original.from.name ?? original.from.address;
  const when = new Date(original.receivedAt).toUTCString();
  const quote = (original.body ?? "").split("\n").map((l) => `> ${l}`).join("\n");
  return `${text.trimEnd()}\n\nOn ${when}, ${who} wrote:\n${quote}`;
}

/** Who a reply goes to, and who's copied with replyAll; your own addresses are left out. */
export function recipients(original: Missive, replyTo: Address[], own: Set<string>, replyAll: boolean): { to: string[]; cc: string[] } {
  const outbound = original.direction === "outbound";
  const notOwn = (a: Address) => !own.has(lower(a.address));
  const base = outbound ? original.to : replyRecipients(original.from, replyTo);
  let to = [...new Set(base.filter(notOwn).map((a) => lower(a.address)))];
  // Replying to a note you sent yourself: it goes back to you.
  if (!to.length && outbound) to = [...new Set(original.to.map((a) => lower(a.address)))];
  if (!replyAll) return { to, cc: [] };
  const already = new Set(to);
  const others = [...(outbound ? [] : original.to), ...(original.cc ?? [])].filter(notOwn).map((a) => lower(a.address));
  const cc = [...new Set(others)].filter((a) => !already.has(a));
  return { to, cc };
}

@Injectable()
export class ReplyService {
  constructor(
    private readonly storage: StorageService,
    private readonly gmail: GmailSendService,
    private readonly mail: MailboxService,
    private readonly groups: GroupsService,
  ) {}

  async plan(missiveId: string, rawText: unknown, replyAll = false): Promise<ReplyPlan> {
    const user = requireUser();
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!text) throw new ReplyError("Write what the reply says.");
    if (text.length > MAX_TEXT) throw new ReplyError(`A reply can be ${MAX_TEXT} characters at most.`);
    const original = missiveId ? await this.storage.getMissive(missiveId) : null;
    if (!original) throw new ReplyError("No such message.", 404);
    if (original.channel !== "email") throw new ReplyError("Only email can be answered this way.");

    // From the address the mail came to (or, for your own sent mail, the one it left from).
    const address = lower(original.accountEmail ?? (original.direction === "outbound" ? original.from.address : ""));
    if (!address) throw new ReplyError("Missive doesn't know which of your addresses this came to, so it can't reply from it.");
    const sendAs = await this.groups.addressesOf(user.id);
    let route: ReplyRoute;
    if (original.provider === "gmail") {
      if (!(await this.gmail.account(address))) {
        throw new ReplyError(`${address} isn't connected for sending. Reconnect it in Missive → Settings → Accounts and allow sending.`);
      }
      route = "gmail";
    } else if (original.provider === "missive") {
      const mailbox = sendAs.find((m) => m.address === address);
      if (!mailbox) throw new ReplyError(`You can't send from ${address}.`);
      if (mailbox.kind === "group" && mailbox.role === "member") throw new ReplyError(`Only owners and moderators can send as ${address}.`);
      route = "missive";
    } else {
      throw new ReplyError(`Replying to ${original.provider} mail isn't supported yet; reply from Missive or ${original.provider} itself.`);
    }

    const own = new Set([address, lower(user.email), ...sendAs.map((m) => lower(m.address))]);
    const replyTo = original.direction === "outbound" ? [] : original.replyTo?.length ? original.replyTo : await this.gmail.replyToOf(original);
    const { to, cc } = recipients(original, replyTo, own, replyAll);
    if (!to.length) throw new ReplyError("This message has no one to reply to.");
    return {
      replyTo: original.id,
      threadId: original.threadId,
      route,
      from: address,
      to,
      cc,
      subject: replySubject(original.subject),
      text,
      original: { from: original.from, subject: original.subject ?? "", receivedAt: original.receivedAt },
    };
  }

  /** Sends the planned reply; refuses when the plan no longer matches what the owner was shown. */
  async send(missiveId: string, text: unknown, replyAll: boolean, expect?: ReplyExpectation): Promise<ReplyPlan & { id: string }> {
    const plan = await this.plan(missiveId, text, replyAll);
    if (expect) {
      const changed =
        (expect.from !== undefined && lower(expect.from) !== plan.from) ||
        (expect.to !== undefined && !sameSet(expect.to, plan.to)) ||
        (expect.cc !== undefined && !sameSet(expect.cc, plan.cc)) ||
        (expect.subject !== undefined && expect.subject.trim() !== plan.subject);
      if (changed) throw new ReplyError("Who this reply goes to has changed since the draft was shown; draft it again.", 409);
    }
    const original = (await this.storage.getMissive(plan.replyTo))!;
    const body = messageBody({ text: quoted(plan.text, original) });
    const outgoing = { from: plan.from, to: plan.to, cc: plan.cc, subject: plan.subject, text: body.text, html: body.html, replyTo: plan.replyTo };
    try {
      const sent = plan.route === "gmail" ? await this.gmail.send(outgoing) : await this.mail.send(outgoing);
      return { ...plan, id: sent.id, threadId: sent.threadId };
    } catch (e) {
      if (e instanceof GmailSendError || e instanceof SendError) throw new ReplyError(e.message);
      throw e;
    }
  }
}
