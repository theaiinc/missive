import { addressIndex } from "./identity-crypto";
import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { createHash } from "node:crypto";
import { simpleParser, type AddressObject } from "mailparser";
import type { Missive, Thread } from "@theaiinc/missive-core";
import { StorageService } from "./storage/storage.service";
import { RuleService } from "./rule.service";
import { UsersService, type Mailbox } from "./users.service";
import { requireUser } from "./request-context";

/**
 * Mailboxes Missive hosts itself (address@custom-domain), like Gmail does.
 * Mail arrives from the edge Worker (Cloudflare Email Routing) and leaves
 * through it (Cloudflare Email Sending). Everything here runs as the
 * mailbox's owner, so it's stored under their account.
 */

type Address = { name?: string; address: string };
export type OutgoingMail = {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  /** Missive id of the message being replied to. */
  replyTo?: string;
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 26);
/** Message-IDs without their angle brackets. */
const bare = (id: string) => id.trim().replace(/^<|>$/g, "");
const addresses = (value: AddressObject | AddressObject[] | undefined): Address[] =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((a) => a.value)
    .filter((a) => a.address)
    .map((a) => ({ address: a.address!.toLowerCase(), name: a.name || undefined }));
const toText = (html: string) => html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

@Injectable()
export class MailboxService {
  private readonly logger = new Logger(MailboxService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly rules: RuleService,
    private readonly users: UsersService,
    private readonly events: EventEmitter2
  ) {}

  /** Ids are derived from the owner and Message-ID, so a redelivered message is stored once. */
  private missiveId(mailbox: string, messageId: string) {
    return `m_${digest(`${requireUser().id}|${mailbox}|${bare(messageId)}`)}`;
  }
  private threadId(rootMessageId: string) {
    return `t_${digest(`${requireUser().id}|${bare(rootMessageId)}`)}`;
  }

  /** Files a message into the owner's thread for it, creating the thread when it's new. */
  private async file(missive: Missive, rootMessageId: string) {
    let thread = await this.storage.getThread(missive.threadId);
    if (!thread) {
      thread = {
        id: missive.threadId,
        provider: "missive",
        providerThreadId: bare(rootMessageId),
        subject: missive.subject,
        participants: [],
        messageCount: 0,
        missiveIds: [],
        lastActivityAt: missive.receivedAt,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    await this.storage.saveThread(thread);
    await this.storage.saveMissive(missive);
    if (!thread.missiveIds.includes(missive.id)) thread.missiveIds.push(missive.id);
    thread.messageCount = thread.missiveIds.length;
    thread.lastActivityAt = missive.receivedAt;
    await this.storage.saveThread(thread);
  }

  /** Stores a message delivered to one of the current user's mailboxes. Returns false for a duplicate. */
  async receive(raw: Buffer, mailbox: Mailbox, envelopeFrom?: string): Promise<boolean> {
    const parsed = await simpleParser(raw);
    const messageId = parsed.messageId ?? `${digest(raw.toString("latin1"))}@missive.local`;
    const id = this.missiveId(mailbox.address, messageId);
    if (await this.storage.getMissive(id)) return false;

    const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? parsed.references.split(/\s+/) : [];
    const root = references[0] ?? parsed.inReplyTo ?? messageId;
    const from = addresses(parsed.from)[0] ?? { address: (envelopeFrom ?? "").toLowerCase() };
    const html = parsed.html ? String(parsed.html) : undefined;
    const now = new Date().toISOString();
    const missive: Missive = {
      id,
      threadId: this.threadId(root),
      channel: "email",
      direction: "inbound",
      provider: "missive",
      providerMessageId: `${await addressIndex("mailboxes.address", mailbox.address)}:${bare(messageId)}`,
      subject: parsed.subject ?? "(no subject)",
      body: parsed.text?.trim() || (html ? toText(html) : "") || "(no content)",
      bodyHtml: html,
      from,
      to: addresses(parsed.to).length ? addresses(parsed.to) : [{ address: mailbox.address }],
      cc: addresses(parsed.cc),
      status: "unread",
      folder: "inbox",
      accountEmail: mailbox.address,
      receivedAt: (parsed.date ?? new Date()).toISOString(),
      createdAt: now,
      updatedAt: now,
    };
    await this.file(missive, root);

    const actions = await this.rules.evaluate(missive);
    if (actions.length) await this.rules.applyActions(missive.id, actions);
    this.events.emit("missive.received", { type: "missive.received", timestamp: now, payload: missive });
    this.logger.log("Received mail for a hosted mailbox");
    return true;
  }

  /** Sends from one of the current user's mailboxes and files the message in Sent. */
  async send(mail: OutgoingMail): Promise<Missive> {
    const user = requireUser();
    const from = mail.from.toLowerCase();
    const mailbox = (await this.users.mailboxesOf(user.id)).find((m) => m.address === from);
    if (!mailbox) throw new SendError("You can only send from your own mailboxes.");

    // Threading: reply to the original's Message-ID and carry its thread root.
    let inReplyTo: string | undefined;
    let root: string | undefined;
    if (mail.replyTo) {
      const original = await this.storage.getMissive(mail.replyTo);
      if (!original) throw new SendError("The message you're replying to is gone.");
      const thread = await this.storage.getThread(original.threadId);
      if (original.provider === "missive") inReplyTo = original.providerMessageId.slice(original.providerMessageId.indexOf(":") + 1);
      root = thread?.providerThreadId ?? inReplyTo;
    }

    const html = `<div style="font:15px/1.6 -apple-system,Segoe UI,Inter,sans-serif">${mail.text
      .split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`).join("")}</div>`;
    const headers: Record<string, string> = {};
    if (inReplyTo) {
      headers["In-Reply-To"] = `<${inReplyTo}>`;
      headers["References"] = root && root !== inReplyTo ? `<${root}> <${inReplyTo}>` : `<${inReplyTo}>`;
    }

    const response = await fetch(`${process.env.EDGE_URL}/internal/send`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.EDGE_SECRET}` },
      body: JSON.stringify({
        from: { email: mailbox.address, name: mailbox.displayName ?? user.name ?? mailbox.address },
        to: mail.to,
        cc: mail.cc?.length ? mail.cc : undefined,
        subject: mail.subject,
        text: mail.text,
        html,
        headers,
      }),
    });
    const result = (await response.json().catch(() => ({}))) as { messageId?: string; error?: string };
    if (!response.ok || !result.messageId) throw new SendError(result.error ?? `Sending failed (${response.status}).`);

    const messageId = bare(result.messageId);
    const threadRoot = root ?? messageId;
    const now = new Date().toISOString();
    const missive: Missive = {
      id: this.missiveId(mailbox.address, messageId),
      threadId: this.threadId(threadRoot),
      channel: "email",
      direction: "outbound",
      provider: "missive",
      providerMessageId: `${await addressIndex("mailboxes.address", mailbox.address)}:${messageId}`,
      subject: mail.subject,
      body: mail.text,
      bodyHtml: html,
      from: { address: mailbox.address, name: mailbox.displayName ?? user.name },
      to: mail.to.map((address) => ({ address })),
      cc: (mail.cc ?? []).map((address) => ({ address })),
      status: "read",
      folder: "sent",
      accountEmail: mailbox.address,
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.file(missive, threadRoot);
    return missive;
  }
}

/** A send problem the person can fix; shown to them as-is. */
export class SendError extends Error {}
