import { safeError } from "./log-safe";
import { Injectable } from "@nestjs/common";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { ConnectorStore, type StoredConnector } from "./connector.store";
import { StorageService } from "./storage/storage.service";
import { RuleService } from "./rule.service";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { Missive } from "@theaiinc/missive-core";

export interface ImapConfig {
  host: string;
  port: number;
  useTls: boolean;
  user: string;
  password?: string;
  accessToken?: string;
}

@Injectable()
export class ImapSyncService {
  constructor(
    private readonly store: ConnectorStore,
    private readonly storage: StorageService,
    private readonly rules: RuleService,
    private readonly eventEmitter: EventEmitter2
  ) {}

  /** Sync all IMAP accounts, or a specific one by email. */
  async syncImap(email?: string): Promise<Record<string, any>> {
    let accounts: StoredConnector[];

    if (email) {
      const account = await this.store.getByEmail("imap", email);
      accounts = account ? [account] : [];
    } else {
      accounts = await this.store.list("imap");
    }

    if (accounts.length === 0) return {};

    const results: Record<string, any> = {};

    for (const connector of accounts) {
      try {
        const config: ImapConfig = {
          host: connector.tokens.host ?? "outlook.office365.com",
          port: connector.tokens.port ?? 993,
          useTls: connector.tokens.useTls !== false,
          user: connector.email,
          password: connector.tokens.password ?? undefined,
        };

        // If this connector has an oauthProviderId, get a fresh OAuth token
        if (connector.tokens.oauthProviderId) {
          const oauthId = connector.tokens.oauthProviderId as string;
          const oauthConnector = await this.store.get(oauthId);
          if (oauthConnector) {
            if (oauthConnector.provider === "outlook") {
              config.accessToken = await this.store.getValidOutlookToken(oauthId);
            } else if (oauthConnector.provider === "gmail") {
              config.accessToken = await this.store.getValidGmailToken(oauthId);
            }
          }
        }

        const synced = await this.syncAccount(connector, config);
        results[connector.email] = { synced };

        // Track last sync time
        await this.store.updateLastSyncAt(connector.id).catch(() => {});
      } catch (err) {
        console.error("IMAP sync error:", safeError(err));
        results[connector.email] = { error: "Sync failed" };
      }
    }

    return results;
  }

  /** Test IMAP connection with given config, returns the username if successful. */
  async testConnection(config: ImapConfig): Promise<string> {
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.useTls,
      tls: {
        rejectUnauthorized: false,
      },
      disableAutoIdle: true,
      auth: config.accessToken
        ? { user: config.user, accessToken: config.accessToken }
        : { user: config.user, pass: config.password! },
      // The protocol log carries the username and server responses (which can
      // quote mailbox contents), so it stays off, as in syncAccount.
      logger: false,
    });

    try {
      await client.connect();
      console.log(`[IMAP] Connected OK to ${config.host}:${config.port}`);
      await client.logout();
      return config.user;
    } catch (err: any) {
      // Extract actual IMAP server response text for meaningful error messages
      const imapResponse = err.response?.text || err.responseText || err.message || String(err);
      console.error(`[IMAP] FAILED for ${config.host}:${config.port}:`, safeError(err));
      throw new Error(`IMAP connection failed: ${imapResponse}`);
    }
  }

  /** Sync a single IMAP account */
  private async syncAccount(
    connector: StoredConnector,
    config: ImapConfig
  ): Promise<number> {
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.useTls,
      tls: {
        rejectUnauthorized: false,
      },
      disableAutoIdle: true,
      auth: config.accessToken
        ? { user: config.user, accessToken: config.accessToken }
        : { user: config.user, pass: config.password! },
      logger: false,
    });

    try {
      await client.connect();

      const lock = await client.getMailboxLock("INBOX");
      let synced = 0;

      try {
        // Get message count to determine fetch range (after lock is acquired)
        const mboxStatus = await client.status("INBOX", { messages: true });
        const total = mboxStatus.messages ?? 0;
        const start = Math.max(1, total - 29);
        const range = `${start}:*`;

        for await (const msg of client.fetch(range, {
          uid: true,
          source: true,
          envelope: true,
          internalDate: true,
        })) {
          if (!msg.source) continue;

          const providerMessageId = String(msg.uid);

          // Skip if already synced with full bodyHtml
          const existing = await this.storage.getMissiveSyncState(providerMessageId);
          // New means never stored. A stored message is fetched again only to
          // repair a body that came in empty; that repair keeps its read state
          // and isn't counted, announced, re-run through rules or re-added to
          // its thread. (Skipping only when bodyHtml was present re-fetched every
          // plain-text email on each sync, reported it as new and reset it to
          // unread.)
          if (existing && !existing.needsBodyRepair) continue;
          const isNew = !existing;

          // Parse the raw email
          const parsed = await simpleParser(msg.source);

          const fromValue = Array.isArray(parsed.from)
            ? parsed.from[0]
            : parsed.from;
          const fromAddress = fromValue?.value?.[0]?.address ?? "";
          const fromName = fromValue?.value?.[0]?.name ?? undefined;
          const toValue = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
          const toList = toValue?.value?.map((v: any) => ({
            address: v.address ?? "",
            name: v.name ?? undefined,
          })) ?? [{ address: config.user }];
          const subject = parsed.subject ?? "(no subject)";

          // Parse attachments for CID-based images
          const attachments = parsed.attachments ?? [];
          let bodyHtml = parsed.html ? String(parsed.html) : undefined;

          // Inline CID images
          if (bodyHtml && attachments.length > 0) {
            bodyHtml = this.inlineCidImages(bodyHtml, attachments);
          }

          const body =
            parsed.text ??
            (bodyHtml ? stripHtml(bodyHtml) : "(no content)");
          const dateRaw = parsed.date ?? msg.internalDate ?? new Date();

          // Build thread ID from Message-ID / References
          const messageId = parsed.messageId ?? providerMessageId;
          const references = parsed.references ?? "";
          const inReplyTo = parsed.inReplyTo ?? "";
          const providerThreadId =
            (typeof references === "string"
              ? references.split(",")[0]?.trim()
              : undefined) ??
            (typeof inReplyTo === "string" ? inReplyTo.trim() : undefined) ??
            messageId;

          let thread = await this.storage.getThread(providerThreadId);
          if (!thread) {
            thread = {
              id: providerThreadId,
              provider: "imap",
              providerThreadId,
              subject,
              participants: [],
              messageCount: 0,
              missiveIds: [],
              lastActivityAt: dateRaw.toISOString(),
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            await this.storage.saveThread(thread);
          }

          const missive: Missive = {
            id: providerMessageId,
            threadId: providerThreadId,
            channel: "email",
            direction: "inbound",
            provider: "imap",
            providerMessageId,
            subject,
            body: body || "(no content)",
            bodyHtml,
            from: {
              name: fromName,
              address: fromAddress,
            },
            to: toList,
            status: existing?.status ?? "unread",
            accountEmail: connector.email,
            receivedAt: dateRaw.toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

          await this.storage.saveMissive(missive);
          if (!isNew) continue;

          // Apply rules
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
      } finally {
        lock.release();
        await client.logout();
      }

      return synced;
    } catch (err) {
      try {
        await client.logout();
      } catch {}
      throw err;
    }
  }

  /** Resolve cid: references in HTML using mailparser attachment data */
  private inlineCidImages(
    html: string,
    attachments: { contentId?: string; contentType?: string; content?: Buffer; filename?: string }[]
  ): string {
    let result = html;
    for (const att of attachments) {
      if (!att.contentId || !att.content) continue;
      const cid = att.contentId.replace(/^<|>$/g, ""); // strip angle brackets
      const mime = att.contentType ?? "image/png";
      const base64 = att.content.toString("base64");
      const dataUri = `data:${mime};base64,${base64}`;
      // replace cid: references
      result = result.replaceAll(`cid:${cid}`, dataUri);
      result = result.replaceAll(`cid:${att.contentId}`, dataUri);
    }
    return result;
  }
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
