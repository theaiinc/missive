import { Injectable } from "@nestjs/common";
import { google } from "googleapis";
import type { Missive } from "@theaiinc/missive-core";
import { ConnectorStore } from "./connector.store";
import { StorageService } from "./storage/storage.service";
import { requireUser } from "./request-context";
import { parseAddressList, type Address } from "./addresses";

export interface GmailOutgoing {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  readReceipt?: boolean;
}

export class GmailSendError extends Error {}

/** A header value with non-ASCII text, as RFC 2047 encoded-words. */
export const encodeHeader = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();

/** The raw RFC 2822 message Gmail's users.messages.send takes (base64url of this). */
export function buildMime(m: GmailOutgoing & { fromName?: string; inReplyTo?: string; references?: string }): string {
  const boundary = `missive-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const from = m.fromName ? `${encodeHeader(m.fromName.replace(/["\r\n]/g, ""))} <${m.from}>` : m.from;
  const headers = [
    `From: ${from}`,
    `To: ${m.to.join(", ")}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    `Subject: ${encodeHeader(m.subject.replace(/[\r\n]+/g, " "))}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    ...(m.readReceipt ? [`Disposition-Notification-To: ${m.from}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(body, "utf8").toString("base64"))].join("\r\n");
  return [...headers, "", part("text/plain", m.text), part("text/html", m.html), `--${boundary}--`, ""].join("\r\n");
}

/**
 * Sends from a connected Gmail account (the gmail.send scope it was connected
 * with), so mail that came in through Gmail can be answered from the same
 * address, in the same Gmail thread. The sent message is filed in Sent here
 * right away; the next sync finds the same Gmail message and keeps one copy.
 */
@Injectable()
export class GmailSendService {
  constructor(
    private readonly store: ConnectorStore,
    private readonly storage: StorageService,
  ) {}

  /** The connected Gmail account for this address, if the current user has one. */
  async account(address: string) {
    const account = await this.store.getByEmail("gmail", address.toLowerCase());
    return account && account.status !== "needs_reauth" ? account : undefined;
  }

  /** A Gmail message's Reply-To, read from Gmail (for messages synced before it was stored). */
  async replyToOf(original: Missive): Promise<Address[]> {
    if (original.provider !== "gmail" || !original.accountEmail) return [];
    const account = await this.account(original.accountEmail);
    if (!account) return [];
    try {
      const oauth2 = this.store.createOAuth2Client();
      oauth2.setCredentials({ access_token: await this.store.getValidGmailToken(account.id) });
      const gmail = google.gmail({ version: "v1", auth: oauth2 as never });
      const meta = await gmail.users.messages.get({ userId: "me", id: original.providerMessageId, format: "metadata", metadataHeaders: ["Reply-To"] });
      return parseAddressList(meta.data.payload?.headers?.find((h) => h.name?.toLowerCase() === "reply-to")?.value);
    } catch {
      return [];
    }
  }

  async send(mail: GmailOutgoing): Promise<Missive> {
    const user = requireUser();
    const account = await this.store.getByEmail("gmail", mail.from.toLowerCase());
    if (!account) throw new GmailSendError(`${mail.from} isn't a connected Gmail account.`);
    if (account.status === "needs_reauth") throw new GmailSendError(`Reconnect ${account.email} in Settings → Accounts to send from it.`);

    const oauth2 = this.store.createOAuth2Client();
    oauth2.setCredentials({ access_token: await this.store.getValidGmailToken(account.id) });
    const gmail = google.gmail({ version: "v1", auth: oauth2 as never });

    // A reply carries the original's Message-ID and goes into its Gmail thread.
    let threadId: string | undefined;
    let inReplyTo: string | undefined;
    let references: string | undefined;
    let original: Missive | null = null;
    if (mail.replyTo) {
      original = await this.storage.getMissive(mail.replyTo);
      if (!original) throw new GmailSendError("The message you're replying to is gone.");
      if (original.provider === "gmail") {
        const meta = await gmail.users.messages.get({
          userId: "me",
          id: original.providerMessageId,
          format: "metadata",
          metadataHeaders: ["Message-ID", "References"],
        });
        threadId = meta.data.threadId ?? undefined;
        const header = (name: string) => meta.data.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
        inReplyTo = header("Message-ID");
        references = [header("References"), inReplyTo].filter(Boolean).join(" ") || undefined;
      }
    }

    const raw = buildMime({ ...mail, fromName: user.name, inReplyTo, references });
    let sent;
    try {
      sent = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: Buffer.from(raw, "utf8").toString("base64url"), ...(threadId ? { threadId } : {}) },
      });
    } catch (e) {
      const status = (e as { code?: number; status?: number }).code ?? (e as { status?: number }).status;
      if (status === 403) throw new GmailSendError(`Gmail didn't allow sending from ${account.email}. Reconnect it in Settings → Accounts and allow sending.`);
      throw new GmailSendError(`Gmail couldn't send it (${e instanceof Error ? e.message : String(e)}).`);
    }

    const id = sent.data.id!;
    const now = new Date().toISOString();
    const missive: Missive = {
      id,
      threadId: original?.provider === "gmail" ? original.threadId : (sent.data.threadId ?? id),
      channel: "email",
      direction: "outbound",
      provider: "gmail",
      providerMessageId: id,
      subject: mail.subject,
      body: mail.text,
      bodyHtml: mail.html,
      from: { address: account.email, name: user.name },
      to: mail.to.map((address) => ({ address })),
      cc: (mail.cc ?? []).map((address) => ({ address })),
      status: "read",
      folder: "sent",
      accountEmail: account.email,
      receivedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.storage.saveMissive(missive);
    const thread = await this.storage.getThread(missive.threadId);
    if (thread) {
      if (!thread.missiveIds.includes(id)) thread.missiveIds.push(id);
      thread.messageCount = thread.missiveIds.length;
      thread.lastActivityAt = now;
      await this.storage.saveThread(thread);
    }
    return missive;
  }
}
