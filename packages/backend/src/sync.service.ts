import { safeError } from "./log-safe";
import { Injectable } from "@nestjs/common";
import { google } from "googleapis";
import { ConnectorStore, type StoredConnector } from "./connector.store";
import { StorageService } from "./storage/storage.service";
import { RuleService } from "./rule.service";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { Missive } from "@theaiinc/missive-core";

@Injectable()
export class SyncService {
  constructor(
    private readonly store: ConnectorStore,
    private readonly storage: StorageService,
    private readonly rules: RuleService,
    private readonly eventEmitter: EventEmitter2
  ) {}

  /** Sync all Gmail accounts, or a specific one by email. */
  async syncGmail(email?: string): Promise<Record<string, any>> {
    let accounts: StoredConnector[];

    if (email) {
      const account = await this.store.getByEmail("gmail", email);
      accounts = account ? [account] : [];
    } else {
      accounts = await this.store.list("gmail");
    }

    if (accounts.length === 0) {
      return {};
    }

    const results: Record<string, any> = {};

    for (const connector of accounts) {
      try {
        const oauth2 = this.store.getOAuthClientForConnector(connector);

        // Refresh if expired
        if (
          connector.tokens.expiry_date &&
          Date.now() >= connector.tokens.expiry_date
        ) {
          const { credentials } = await oauth2.refreshAccessToken();
          connector.tokens = credentials as typeof connector.tokens;
        }

        const gmail = google.gmail({ version: "v1", auth: oauth2 as any });

        const listRes = await gmail.users.messages.list({
          userId: "me",
          maxResults: 50,
          q: "in:inbox",
        });

        const messages = listRes.data.messages ?? [];
        let synced = 0;

        for (const msg of messages) {
          const existing = await this.storage.getMissiveSyncState(msg.id!);
          // New means never stored. A stored message is fetched again only to
          // repair a body that came in empty; that repair keeps its read state
          // and isn't counted, announced, re-run through rules or re-added to
          // its thread. (Skipping only when bodyHtml was present re-fetched every
          // plain-text email on each sync, reported it as new and reset it to
          // unread.)
          if (existing && !existing.needsBodyRepair) continue;
          const isNew = !existing;

          const detail = await gmail.users.messages.get({
            userId: "me",
            id: msg.id!,
            format: "full",
          });

          const headers = detail.data.payload?.headers ?? [];
          const header = (name: string) =>
            headers.find((h) => h.name === name)?.value ?? undefined;

          const subject = header("Subject");
          const fromRaw = header("From") ?? "";
          const fromMatch = fromRaw.match(
            /^(?:"?([^"]*)"?\s)?<?([^>]+)>?$/
          );
          const dateRaw = header("Date");
          const toRaw = header("To") ?? "";

          // ── Extract bodies ──
          const parts = flattenParts(detail.data.payload);
          const textPart = parts.find((p) => p.mimeType === "text/plain");
          const htmlPart = parts.find((p) => p.mimeType === "text/html");

          // Decode body from inline data or fetch via attachment API
          let bodyHtml = await this.decodeGmailBody(htmlPart, gmail, msg.id!);
          const textBody = await this.decodeGmailBody(textPart, gmail, msg.id!);

          if (bodyHtml) {
            bodyHtml = await this.inlineCidImages(bodyHtml, parts, gmail, msg.id!);
          }

          const body = textBody || (bodyHtml ? stripHtml(bodyHtml) : "(no content)");

          // ── Thread ──
          const providerThreadId = detail.data.threadId ?? msg.id!;

          let thread = await this.storage.getThread(providerThreadId);
          if (!thread) {
            thread = {
              id: providerThreadId,
              provider: "gmail",
              providerThreadId,
              subject,
              participants: [],
              messageCount: 0,
              missiveIds: [],
              lastActivityAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            await this.storage.saveThread(thread);
          }

          const missive: Missive = {
            id: msg.id!,
            threadId: providerThreadId,
            channel: "email",
            direction: "inbound",
            provider: "gmail",
            providerMessageId: msg.id!,
            subject,
            body: body || "(no content)",
            bodyHtml,
            from: {
              name: fromMatch?.[1],
              address: fromMatch?.[2] ?? fromRaw,
            },
            to: toRaw.split(",").map((addr: string) => ({
              address: addr.trim(),
            })),
            status: existing?.status ?? "unread",
            accountEmail: connector.email,
            receivedAt: dateRaw
              ? new Date(dateRaw).toISOString()
              : new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

          await this.storage.saveMissive(missive);
          if (!isNew) continue;

          // Apply rules to the newly synced missive
          const ruleActions = await this.rules.evaluate(missive);
          if (ruleActions.length > 0) {
            await this.rules.applyActions(missive.id, ruleActions);
          }

          if (!thread.missiveIds.includes(missive.id)) thread.missiveIds.push(missive.id);
          thread.messageCount = thread.missiveIds.length;
          thread.lastActivityAt = new Date().toISOString();
          await this.storage.saveThread(thread);

          this.eventEmitter.emit("missive.received", {
            type: "missive.received",
            timestamp: new Date().toISOString(),
            payload: missive,
          });

          synced++;
        }

        results[connector.email] = { synced };

        // Track last sync time
        await this.store.updateLastSyncAt(connector.id).catch(() => {});
      } catch (err) {
        console.error("Gmail sync error:", safeError(err));
        results[connector.email] = { error: "Sync failed" };
      }
    }

    return results;
  }

  /** Sync Outlook / Microsoft 365 accounts */
  async syncOutlook(email?: string): Promise<Record<string, any>> {
    let accounts: StoredConnector[];

    if (email) {
      const account = await this.store.getByEmail("outlook", email);
      accounts = account ? [account] : [];
    } else {
      accounts = await this.store.list("outlook");
    }

    if (accounts.length === 0) {
      return {};
    }

    const results: Record<string, any> = {};

    for (const connector of accounts) {
      try {
        // Refresh if expired
        let tokens = connector.tokens;
        if (tokens.expiry_date && Date.now() >= tokens.expiry_date) {
          tokens = await this.store.refreshOutlookTokens(
            tokens.refresh_token ?? ""
          );
        }

        const headers: Record<string, string> = {
          Authorization: `Bearer ${tokens.access_token}`,
          "Content-Type": "application/json",
        };

        // Fetch messages from Graph API
        const listRes = await fetch(
          "https://graph.microsoft.com/v1.0/me/messages?$top=10&$filter=isDraft eq false&$orderby=receivedDateTime desc",
          { headers }
        );
        if (!listRes.ok) {
          const text = await listRes.text();
          throw new Error(`Graph API list error: ${listRes.status} ${text}`);
        }
        const listData = (await listRes.json()) as { value?: any[] };
        const messages: any[] = listData.value ?? [];
        let synced = 0;

        for (const msg of messages) {
          if (await this.storage.missiveExists(msg.id)) continue;

          const subject = msg.subject ?? "";
          const fromRaw = msg.from?.emailAddress?.address ?? "";
          const fromName = msg.from?.emailAddress?.name ?? "";
          const dateRaw = msg.receivedDateTime;
          const toRaw = msg.toRecipients
            ?.map((r: any) => r.emailAddress?.address)
            .filter(Boolean)
            .join(", ");

          // Fetch full message body
          const detailRes = await fetch(
            `https://graph.microsoft.com/v1.0/me/messages/${msg.id}?$select=id,body,bodyPreview`,
            { headers }
          );
          const detail = (await detailRes.json()) as { body?: { contentType?: string; content?: string }; bodyPreview?: string };
          const htmlBody = detail.body?.contentType === "html"
            ? detail.body.content
            : undefined;
          const plainBody =
            detail.body?.contentType === "text"
              ? detail.body.content
              : detail.bodyPreview ?? "";

          const providerThreadId = msg.conversationId ?? msg.id;

          let thread = await this.storage.getThread(providerThreadId);
          if (!thread) {
            thread = {
              id: providerThreadId,
              provider: "outlook",
              providerThreadId,
              subject,
              participants: [],
              messageCount: 0,
              missiveIds: [],
              lastActivityAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            await this.storage.saveThread(thread);
          }

          const missive: Missive = {
            id: msg.id,
            threadId: providerThreadId,
            channel: "email",
            direction:
              msg.internetMessageHeaders?.find(
                (h: any) => h.name === "message-id"
              )
                ? "inbound"
                : "outbound",
            provider: "outlook",
            providerMessageId: msg.id,
            subject,
            body: htmlBody ? stripHtml(htmlBody) : plainBody || "(no content)",
            bodyHtml: htmlBody,
            from: {
              name: fromName || undefined,
              address: fromRaw,
            },
            to: toRaw
              ? toRaw.split(",").map((addr: string) => ({ address: addr.trim() }))
              : [],
            status: "unread",
            accountEmail: connector.email,
            receivedAt: dateRaw
              ? new Date(dateRaw).toISOString()
              : new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

          await this.storage.saveMissive(missive);

          // Apply rules to the newly synced missive
          const ruleActions = await this.rules.evaluate(missive);
          if (ruleActions.length > 0) {
            await this.rules.applyActions(missive.id, ruleActions);
          }

          if (!thread.missiveIds.includes(missive.id)) thread.missiveIds.push(missive.id);
          thread.messageCount = thread.missiveIds.length;
          thread.lastActivityAt = new Date().toISOString();
          await this.storage.saveThread(thread);

          this.eventEmitter.emit("missive.received", {
            type: "missive.received",
            timestamp: new Date().toISOString(),
            payload: missive,
          });

          synced++;
        }

        results[connector.email] = { synced };

        // Track last sync time
        await this.store.updateLastSyncAt(connector.id).catch(() => {});
      } catch (err) {
        console.error("Outlook sync error:", safeError(err));
        results[connector.email] = { error: "Sync failed" };
      }
    }

    return results;
  }

  /**
   * Decode a Gmail message part body — handles both inline data and
   * attachmentId (used when the body is too large for inline storage).
   */
  private async decodeGmailBody(
    part: { mimeType: string; body?: { data?: string; attachmentId?: string; size?: number } } | undefined,
    gmail: ReturnType<typeof google.gmail>,
    messageId: string
  ): Promise<string | undefined> {
    if (!part?.body) return undefined;
    // When data is present inline (no attachmentId) — decode directly
    if (part.body.data && !part.body.attachmentId) {
      return Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
    // When the body is stored as an attachment (common for large/complex HTML)
    const attId = part.body.attachmentId;
    if (attId) {
      try {
        const attRes = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId,
          id: attId,
        });
        const attData = (attRes.data as any).data;
        if (attData && typeof attData === "string") {
          return Buffer.from(attData, "base64url").toString("utf-8");
        }
      } catch {
        // fall through
      }
    }
    return undefined;
  }

  /** Resolve cid: references in HTML to inline base64 data URIs */
  private async inlineCidImages(
    html: string,
    parts: { mimeType: string; body?: { data?: string; attachmentId?: string }; filename?: string; headers?: { name: string; value: string }[] }[],
    gmail: ReturnType<typeof google.gmail>,
    messageId: string
  ): Promise<string> {
    const cidRegex = /cid:([^\s"'>]+)/g;
    let result = html;
    const matches = html.matchAll(cidRegex);

    for (const match of matches) {
      const cid = match[1]!;
      // Find attachment with matching Content-ID
      const attachment = parts.find((p) => {
        const contentIdHeader = p.headers?.find(
          (h) => h.name?.toLowerCase() === "content-id"
        );
        if (!contentIdHeader?.value) return false;
        const v: string = contentIdHeader.value;
        return v.includes(cid) || v === `<${cid}>`;
      });

      if (attachment?.body?.attachmentId) {
        try {
          const attRes = await gmail.users.messages.attachments.get({
            userId: "me",
            messageId,
            id: attachment.body.attachmentId,
          });
          const attData = attRes.data;
          const rawData = (attData as any).data;
          if (rawData && typeof rawData === "string") {
            const mime = attachment.mimeType || "image/png";
            const standard = rawData.replace(/-/g, "+").replace(/_/g, "/");
            result = result.replaceAll(`cid:${cid}`, `data:${mime};base64,${standard}`);
          }
        } catch {
          // skip failed image inlining
        }
      }
    }

    return result;
  }
}

/** Recursively flatten MIME parts */
function flattenParts(payload: any): any[] {
  const parts: any[] = [];
  if (!payload) return parts;

  // Always include leaf parts (text/plain, text/html) and multipart containers
  if (payload.mimeType && (payload.body || payload.parts)) {
    parts.push(payload);
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      parts.push(...flattenParts(p));
    }
  }
  return parts;
}

/** Minimal HTML-to-text: strip tags, decode common entities */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/td>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
