import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { Missive, Thread } from "@theaiinc/missive-core";
import { ConnectorStore, type StoredConnector } from "./connector.store";
import { StorageService } from "./storage/storage.service";
import { UsersService } from "./users.service";
import { requireUser, runAsUser, type RequestUser } from "./request-context";
import { safeError } from "./log-safe";
import { createHash } from "node:crypto";
import { PostgresService } from "./storage/postgres.service";
import {
  HookInputError,
  isHookProvider,
  newHookKey,
  webhookUrl,
  wecomApi,
  wecomCallback,
  wecomConnect,
  wecomSend,
  wecomVerifyUrl,
  fromKf,
  zaloConnect,
  zaloEvent,
  type HookProvider,
  type HookSetup,
  type WecomCredentials,
  type ZaloCredentials,
} from "./chat/hook-providers";
import { ZaloApi, ZaloError } from "./chat/zalo-api";
import {
  BOT_PROVIDERS,
  BotAuthError,
  CHAT_PROVIDERS,
  CHAT_PROVIDER_NAMES,
  botIdentity,
  chatMissiveId,
  chatThreadId,
  runDiscord,
  runTelegram,
  sendChat,
  type BotProvider,
  type ChatMessage,
  type ChatProvider,
} from "./chat-bots";

/** A chat-app connector's credentials (stored encrypted, like any connector's). */
type BotCredentials = { botToken: string; botId: string };

export type ChatAccount = {
  id: string;
  provider: ChatProvider;
  /** What the person called it, e.g. the project it's for. */
  label: string;
  /** The bot, e.g. "@cinely_bot" or "Missive#6538". */
  handle: string;
  connectedAt: string;
  running: boolean;
  needsReauth: boolean;
  lastError: string | null;
  /** WeCom and Zalo: the webhook URL (and WeCom's callback Token and EncodingAESKey) to enter in the app. */
  setup?: HookSetup;
};

/** What a webhook call gets back. */
export type HookReply = { status: number; body: string };

/** Credentials for WeCom or Zalo, as entered in Settings. */
export type HookInput = Record<string, string | undefined>;

export type ChatConversation = {
  id: string;
  provider: ChatProvider;
  title: string;
  label: string | null;
  handle: string | null;
  unread: number;
  lastMessage: { sender: string; text: string; at: string; fromBot: boolean };
};

const isChatProvider = (p: string): p is ChatProvider => (CHAT_PROVIDERS as string[]).includes(p);
const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
/** Zalo access tokens are refreshed this often, which also renews the 3-month refresh token. */
const ZALO_KEEPALIVE_MS = 12 * 60 * 60_000;

/**
 * Telegram and Discord bots, run by Missive itself: each connected bot keeps
 * a connection open (Telegram long polling, the Discord gateway), and every
 * message it sees is filed as a chat missive in its owner's "chat" folder,
 * one thread per conversation. Replies go back out through the same bot.
 * MISSIVE_CHAT_BOTS=off keeps the bots from running on this server.
 */
@Injectable()
export class ChatAppsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("ChatApps");
  private readonly running = new Map<string, AbortController>();
  /** Per conversation, so two messages arriving together can't overwrite each other's thread update. */
  private readonly filing = new Map<string, Promise<void>>();
  private bootTimer?: ReturnType<typeof setTimeout>;
  private keepAliveTimer?: ReturnType<typeof setInterval>;
  /** Names looked up from WeCom and Zalo, by connector and user id. */
  private readonly names = new Map<string, string>();

  constructor(
    private readonly store: ConnectorStore,
    private readonly storage: StorageService,
    private readonly users: UsersService,
    private readonly events: EventEmitter2,
    private readonly pg: PostgresService,
  ) {}

  private get enabled() {
    return process.env.MISSIVE_CHAT_BOTS !== "off" && process.env.NODE_ENV !== "test";
  }

  onModuleInit() {
    if (!this.enabled) return;
    // After migrations and the first sync have had a moment.
    this.bootTimer = setTimeout(() => void this.startAll().catch((e) => this.log.warn(`Couldn't start chat bots: ${safeError(e)}`)), 10_000);
    this.keepAliveTimer = setInterval(() => void this.keepZaloAlive().catch((e) => this.log.warn(`Zalo keep-alive: ${safeError(e)}`)), ZALO_KEEPALIVE_MS);
  }

  onModuleDestroy() {
    clearTimeout(this.bootTimer);
    clearInterval(this.keepAliveTimer);
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
  }

  private async startAll() {
    for (const user of await this.users.all()) {
      await runAsUser(user, async () => {
        for (const provider of BOT_PROVIDERS) {
          for (const connector of await this.store.list(provider)) {
            if (connector.status !== "needs_reauth") this.start(user, connector);
          }
        }
      });
    }
  }

  /** Runs one bot until it's disconnected or its token stops working. */
  private start(user: RequestUser, connector: StoredConnector) {
    if (!this.enabled) return;
    this.running.get(connector.id)?.abort();
    const controller = new AbortController();
    this.running.set(connector.id, controller);
    const provider = connector.provider as ChatProvider;
    if (isHookProvider(provider)) return;
    const { botToken, botId } = connector.tokens as BotCredentials;
    const run = provider === "telegram" ? runTelegram : runDiscord;
    const name = `${provider} bot ${connector.email}`;

    void run({
      token: botToken,
      botId,
      signal: controller.signal,
      onMessage: (message) => runAsUser(user, () => this.file(connector, provider, message)),
      onError: (e) => this.log.warn(`${name}: ${safeError(e)}`),
    })
      .catch((e) =>
        runAsUser(user, async () => {
          this.log.warn(`${name} stopped: ${safeError(e)}`);
          if (e instanceof BotAuthError) await this.store.markNeedsReauth(connector.id, e.message);
        }),
      )
      .finally(() => {
        if (this.running.get(connector.id) === controller) this.running.delete(connector.id);
      });
    this.log.log(`Started ${name}`);
  }

  /** Files one message in its conversation's thread (as the bot's owner). */
  private async file(connector: StoredConnector, provider: ChatProvider, message: ChatMessage): Promise<void> {
    const threadId = chatThreadId(requireUser().id, provider, message.chatId);
    try {
      await this.inOrder(threadId, () => this.save(connector, provider, message, threadId));
    } catch (e) {
      this.log.warn(`Couldn't file a ${provider} message: ${safeError(e)}`);
    }
  }

  /** Runs `job` after every earlier job for the same conversation. */
  private inOrder<T>(threadId: string, job: () => Promise<T>): Promise<T> {
    const previous = this.filing.get(threadId) ?? Promise.resolve();
    const result = previous.then(job);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.filing.set(threadId, settled);
    void settled.then(() => {
      if (this.filing.get(threadId) === settled) this.filing.delete(threadId);
    });
    return result;
  }

  private async save(connector: StoredConnector, provider: ChatProvider, message: ChatMessage, threadId: string): Promise<Missive> {
    const user = requireUser();
    const id = chatMissiveId(user.id, provider, message.chatId, message.messageId);
    const isNew = !(await this.storage.missiveExists(id));
    const now = new Date().toISOString();
    const bot = { name: connector.label, address: `${provider}:${connector.email}` };
    const chat = { name: message.chatTitle, address: `${provider}:chat:${message.chatId}` };
    const missive: Missive = {
      id,
      threadId,
      channel: "chat",
      direction: message.fromBot ? "outbound" : "inbound",
      provider,
      providerMessageId: `${message.chatId}:${message.messageId}`,
      subject: message.chatTitle,
      body: message.text,
      from: message.fromBot ? bot : { name: message.senderName, address: `${provider}:${message.senderId}` },
      to: [message.fromBot ? chat : bot],
      status: message.fromBot ? "read" : "unread",
      folder: "chat",
      accountEmail: connector.email,
      receivedAt: message.at,
      createdAt: now,
      updatedAt: now,
    };

    let thread: Thread | null = await this.storage.getThread(threadId);
    if (!thread) {
      thread = {
        id: threadId,
        provider,
        providerThreadId: message.chatId,
        subject: message.chatTitle,
        participants: [],
        messageCount: 0,
        missiveIds: [],
        lastActivityAt: message.at,
        createdAt: now,
        updatedAt: now,
      } as Thread;
      await this.storage.saveThread(thread);
    }
    await this.storage.saveMissive(missive);
    if (!thread.missiveIds.includes(id)) thread.missiveIds.push(id);
    thread.messageCount = thread.missiveIds.length;
    if (message.at > thread.lastActivityAt) thread.lastActivityAt = message.at;
    await this.storage.saveThread(thread);

    if (isNew && !message.fromBot) {
      this.events.emit("missive.received", { type: "missive.received", timestamp: now, payload: missive });
    }
    return missive;
  }

  // ── For the API (as the signed-in user) ──

  async accounts(): Promise<ChatAccount[]> {
    const all = (await Promise.all(CHAT_PROVIDERS.map((p) => this.store.list(p)))).flat();
    return all.map((c) => ({
      id: c.id,
      provider: c.provider as ChatProvider,
      label: c.label,
      handle: c.email,
      connectedAt: c.connectedAt,
      running: isHookProvider(c.provider) ? c.status !== "needs_reauth" : this.running.has(c.id),
      needsReauth: c.status === "needs_reauth",
      lastError: c.lastError ?? null,
      ...(isHookProvider(c.provider) ? { setup: this.setup(c.provider, c.tokens as WecomCredentials | ZaloCredentials) } : {}),
    }));
  }

  private setup(provider: HookProvider, c: WecomCredentials | ZaloCredentials): HookSetup {
    const url = webhookUrl(process.env.APP_URL ?? "", provider, c.hookKey);
    if (provider === "wecom") {
      const w = c as WecomCredentials;
      return { webhookUrl: url, token: w.token, aesKey: w.aesKey };
    }
    return { webhookUrl: url, needsSecret: !(c as ZaloCredentials).oaSecretKey };
  }

  /** Checks the token with the app, stores it, and starts the bot. */
  async connect(provider: string, token: string, label: string, credentials?: HookInput): Promise<ChatAccount> {
    if (!isChatProvider(provider)) throw new BadRequestException(`Chat apps are ${CHAT_PROVIDERS.join(", ")}`);
    if (isHookProvider(provider)) return this.connectHook(provider, credentials ?? {}, label);
    const botToken = token?.trim();
    if (!botToken) throw new BadRequestException("A bot token is required");
    let identity;
    try {
      identity = await botIdentity(provider, botToken);
    } catch (e) {
      throw new BadRequestException(e instanceof BotAuthError ? e.message : `Couldn't reach ${provider}: ${safeError(e)}`);
    }
    const connector = await this.store.save(provider, {
      provider,
      label: label?.trim() || identity.handle,
      email: identity.handle,
      tokens: { botToken, botId: identity.id } satisfies BotCredentials,
      connectedAt: new Date().toISOString(),
    });
    this.start(requireUser(), connector);
    return (await this.accounts()).find((a) => a.id === connector.id)!;
  }

  // ── Zalo: connecting through the OA admin's "Allow" ──

  /** Started authorizations, by state; each lasts 15 minutes. */
  private readonly zaloPending = new Map<string, { userId: string; appId: string; appSecret: string; label: string; until: number }>();

  private zaloRedirect() {
    return `${(process.env.APP_URL ?? "").replace(/\/$/, "")}/api/v1/chat-apps/zalo/callback`;
  }

  /** Where to send the person so an OA admin can let the Zalo app act for the OA. */
  zaloAuthorize(appId: string, appSecret: string, label: string): { url: string } {
    const id = appId?.trim();
    const secret = appSecret?.trim();
    if (!id || !/^\d+$/.test(id) || !secret) throw new BadRequestException("The Zalo app's App ID and App Secret are required");
    const now = Date.now();
    for (const [k, v] of this.zaloPending) if (v.until < now) this.zaloPending.delete(k);
    const state = newHookKey();
    this.zaloPending.set(state, { userId: requireUser().id, appId: id, appSecret: secret, label: label?.trim() ?? "", until: now + 15 * 60_000 });
    return { url: new ZaloApi(id, secret).permissionUrl(this.zaloRedirect(), state) };
  }

  /** Zalo's redirect after "Allow": trades the code for the OA's tokens and connects the OA. Returns where to go next. */
  async zaloCallback(code: string | undefined, state: string | undefined): Promise<string> {
    const back = (q: string) => `/settings?${q}#chat-apps`;
    const pending = state ? this.zaloPending.get(state) : undefined;
    if (!pending || pending.until < Date.now() || pending.userId !== requireUser().id) {
      return back("chat_error=" + encodeURIComponent("That Zalo authorization expired. Start it again from Settings."));
    }
    this.zaloPending.delete(state!);
    if (!code) return back("chat_error=" + encodeURIComponent("Zalo didn't send an authorization code (was Allow clicked?)"));
    try {
      const api = new ZaloApi(pending.appId, pending.appSecret);
      const tokens = await api.exchangeCode(code);
      const oa = await api.oaInfo(tokens.accessToken!);
      const existing = await this.store.getByEmail("zalo", oa.oaId);
      const old = existing?.tokens as ZaloCredentials | undefined;
      const credentials: ZaloCredentials = {
        appId: pending.appId,
        appSecret: pending.appSecret,
        // The same app keeps its webhook URL and OA Secret Key when it's connected again.
        oaSecretKey: old?.appId === pending.appId ? old.oaSecretKey : "",
        oaId: oa.oaId,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessTokenUntil: tokens.accessTokenUntil,
        hookKey: old?.hookKey ?? newHookKey(),
      };
      await this.saveHook("zalo", oa.oaId, pending.label || oa.name, credentials, existing?.connectedAt);
      return back("chat_connected=zalo");
    } catch (e) {
      return back("chat_error=" + encodeURIComponent(`Zalo didn't connect: ${e instanceof ZaloError ? e.message : safeError(e)}`));
    }
  }

  /** Adds the OA Secret Key Zalo shows once the webhook URL is saved; webhook calls are filed from then on. */
  async setZaloSecret(id: string, oaSecretKey: string): Promise<ChatAccount> {
    const connector = await this.store.get(id);
    if (!connector || connector.provider !== "zalo") throw new NotFoundException("No such Zalo connection");
    const key = oaSecretKey?.trim();
    if (!key) throw new BadRequestException("The OA Secret Key is required");
    await this.saveTokens(connector, { ...(connector.tokens as ZaloCredentials), oaSecretKey: key });
    return (await this.accounts()).find((a) => a.id === id)!;
  }

  /** Stores a WeCom or Zalo connection and (re)registers its webhook key. */
  private async saveHook(provider: HookProvider, handle: string, label: string, credentials: WecomCredentials | ZaloCredentials, connectedAt?: string) {
    const connector = await this.store.save(provider, {
      provider,
      label,
      email: handle,
      tokens: credentials,
      connectedAt: connectedAt ?? new Date().toISOString(),
    });
    await this.pg.query(`DELETE FROM chat_webhooks WHERE connector_id = $1`, [connector.id]);
    await this.pg.query(`INSERT INTO chat_webhooks (key_hash, connector_id, provider) VALUES ($1, $2, $3)`, [
      hashKey(credentials.hookKey),
      connector.id,
      provider,
    ]);
    return connector;
  }

  /** Checks WeCom or Zalo credentials, stores them, and gives the connection its webhook URL. */
  private async connectHook(provider: HookProvider, input: HookInput, label: string): Promise<ChatAccount> {
    let connected: { credentials: WecomCredentials | ZaloCredentials; handle: string; name?: string };
    try {
      connected = provider === "wecom" ? await wecomConnect(input) : await zaloConnect(input);
    } catch (e) {
      throw new BadRequestException(e instanceof HookInputError ? e.message : `Couldn't reach ${CHAT_PROVIDER_NAMES[provider]}: ${safeError(e)}`);
    }
    const existing = await this.store.getByEmail(provider, connected.handle);
    if (existing && provider === "wecom") {
      // Reconnecting keeps the callback Token, EncodingAESKey and URL already entered in WeCom.
      const old = existing.tokens as WecomCredentials;
      Object.assign(connected.credentials, { token: old.token, aesKey: old.aesKey, hookKey: old.hookKey, kfCursors: old.kfCursors });
    } else if (existing) {
      connected.credentials.hookKey = (existing.tokens as ZaloCredentials).hookKey;
    }
    const connector = await this.saveHook(
      provider,
      connected.handle,
      label?.trim() || connected.name || connected.handle,
      connected.credentials,
      existing?.connectedAt,
    );
    return (await this.accounts()).find((a) => a.id === connector.id)!;
  }

  async disconnect(id: string): Promise<void> {
    const connector = await this.store.get(id);
    if (!connector || !isChatProvider(connector.provider)) throw new NotFoundException("No such chat app connection");
    this.running.get(id)?.abort();
    this.running.delete(id);
    await this.pg.query(`DELETE FROM chat_webhooks WHERE connector_id = $1`, [id]);
    await this.store.remove(id);
  }

  // ── Webhooks (WeCom, Zalo): public, verified per connection ──

  /**
   * One call to /api/v1/hooks/:provider/:key. The key finds the connection
   * and its owner; the call is then checked with that connection's signing
   * secret, and filed as the owner.
   */
  async hook(
    provider: string,
    key: string,
    call: { method: string; query: Record<string, string | undefined>; body: string; signature?: string },
  ): Promise<HookReply> {
    const notFound = { status: 404, body: "Not found" };
    if (!isHookProvider(provider) || !key) return notFound;
    const { rows } = await this.pg.systemQuery(
      `SELECT owner_id, connector_id FROM chat_webhooks WHERE key_hash = $1 AND provider = $2`,
      [hashKey(key), provider],
    );
    const owner = rows[0] ? await this.users.byId(rows[0].owner_id) : null;
    if (!owner) return notFound;
    return runAsUser(owner, async () => {
      const connector = await this.store.get(rows[0].connector_id);
      if (!connector || (connector.tokens as { hookKey?: string }).hookKey !== key) return notFound;
      try {
        return provider === "wecom" ? await this.wecomHook(connector, call) : await this.zaloHook(connector, call);
      } catch (e) {
        if (e instanceof HookInputError) return { status: 403, body: e.message };
        this.log.warn(`${provider} webhook: ${safeError(e)}`);
        return { status: 500, body: "Error" };
      }
    });
  }

  private async wecomHook(connector: StoredConnector, call: { method: string; query: Record<string, string | undefined>; body: string }): Promise<HookReply> {
    const credentials = connector.tokens as WecomCredentials;
    if (call.method === "GET") {
      const echo = wecomVerifyUrl(credentials, call.query);
      return echo === null ? { status: 403, body: "Not a genuine WeCom check" } : { status: 200, body: echo };
    }
    const callback = wecomCallback(credentials, call.query, call.body);
    if (callback.kind === "message") {
      const message = callback.message;
      const name = await this.lookupName(connector, message.senderId, () => wecomApi(credentials).memberName(message.senderId));
      if (name) message.chatTitle = message.senderName = name;
      await this.file(connector, "wecom", message);
    } else if (callback.kind === "kf") {
      // WeCom waits 5 s for an answer; the messages are read after it.
      void this.inOrder(`kf:${connector.id}`, () => this.syncKf(connector.id, callback.openKfId, callback.token)).catch((e) =>
        this.log.warn(`WeCom Customer Service sync: ${safeError(e)}`),
      );
    }
    return { status: 200, body: "success" };
  }

  /** Reads new WeChat Customer Service messages since the saved cursor, and files them. */
  private async syncKf(connectorId: string, openKfId: string, callbackToken: string): Promise<void> {
    const connector = await this.store.get(connectorId);
    if (!connector) return;
    const credentials = connector.tokens as WecomCredentials;
    const api = wecomApi(credentials);
    const { messages, cursor } = await api.syncKf(openKfId, credentials.kfCursors?.[openKfId], callbackToken);
    const customers = [...new Set(messages.filter((m) => m.origin === 3 && m.external_userid).map((m) => m.external_userid!))];
    const names = await api.kfCustomerNames(customers);
    for (const message of fromKf(messages, names)) await this.file(connector, "wecom", message);
    if (cursor && cursor !== credentials.kfCursors?.[openKfId]) {
      await this.saveTokens(connector, { ...credentials, kfCursors: { ...credentials.kfCursors, [openKfId]: cursor } });
    }
  }

  private async zaloHook(connector: StoredConnector, call: { method: string; body: string; signature?: string }): Promise<HookReply> {
    // Zalo checks the URL when it's saved, before its OA Secret Key exists to sign anything:
    // answer, but file nothing until the key is added.
    if (call.method !== "POST" || !(connector.tokens as ZaloCredentials).oaSecretKey) return { status: 200, body: "ok" };
    const message = zaloEvent(connector.tokens as ZaloCredentials, call.body, call.signature);
    // Zalo wants an answer within 2 seconds: the call is genuine, so answer now
    // and look up the sender's name and file the message after.
    if (message) {
      const job = this.fileZalo(connector, message).catch((e) => this.log.warn(`Zalo message: ${safeError(e)}`));
      this.background.add(job);
      void job.finally(() => this.background.delete(job));
    }
    return { status: 200, body: "ok" };
  }

  private async fileZalo(connector: StoredConnector, message: ChatMessage): Promise<void> {
    const userId = message.chatId;
    const c = connector.tokens as ZaloCredentials;
    const name = await this.lookupName(connector, userId, async () => {
      const token = await this.zaloAccessToken(connector.id);
      return token ? new ZaloApi(c.appId, c.appSecret).userName(token, userId) : undefined;
    });
    if (name) {
      message.chatTitle = name;
      if (!message.fromBot) message.senderName = name;
    }
    await this.file(connector, "zalo", message);
  }

  /** Work started by a webhook after it was answered (tests wait on it). */
  readonly background = new Set<Promise<unknown>>();

  /** Resolves once every webhook's after-work has finished. */
  async settled(): Promise<void> {
    while (this.background.size) await Promise.all([...this.background]);
  }

  private async lookupName(connector: StoredConnector, id: string, find: () => Promise<string | undefined>): Promise<string | undefined> {
    const key = `${connector.id}|${id}`;
    if (this.names.has(key)) return this.names.get(key);
    const name = await find().catch(() => undefined);
    if (name) this.names.set(key, name);
    return name;
  }

  /** Stores new credentials (a Zalo token pair, a WeCom cursor) for a connection. */
  private async saveTokens(connector: StoredConnector, tokens: Record<string, any>): Promise<void> {
    const { id: _id, ...rest } = connector;
    await this.store.save(connector.provider, { ...rest, tokens });
  }

  /**
   * A working Zalo access token, refreshing it when needed. Each refresh
   * spends the refresh token, so refreshes for one connection run one at a
   * time and the new pair is stored before anyone else reads it.
   */
  private zaloAccessToken(connectorId: string): Promise<string | undefined> {
    return this.inOrder(`zalo-token:${connectorId}`, async () => {
      const connector = await this.store.get(connectorId);
      if (!connector) return undefined;
      const c = connector.tokens as ZaloCredentials;
      if (c.accessToken && (c.accessTokenUntil ?? 0) > Date.now()) return c.accessToken;
      try {
        const fresh = await new ZaloApi(c.appId, c.appSecret).refresh(c.refreshToken);
        await this.saveTokens(connector, { ...c, ...fresh });
        return fresh.accessToken;
      } catch (e) {
        if (e instanceof ZaloError) {
          await this.store.markNeedsReauth(connector.id, `Zalo refused the refresh token; connect the OA again with a new one. (${e.message})`);
        }
        throw e;
      }
    });
  }

  /** Refreshes every Zalo connection's token in time, so the refresh token never lapses. */
  private async keepZaloAlive(): Promise<void> {
    for (const user of await this.users.all()) {
      await runAsUser(user, async () => {
        for (const connector of await this.store.list("zalo")) {
          if (connector.status === "needs_reauth") continue;
          await this.zaloAccessToken(connector.id).catch((e) => this.log.warn(`Zalo token for ${connector.email}: ${safeError(e)}`));
        }
      });
    }
  }

  async conversations(): Promise<ChatConversation[]> {
    const accounts = new Map((await this.accounts()).map((a) => [`${a.provider}:${a.handle}`, a]));
    const rows = await this.storage.chatConversations();
    const threads = new Map((await this.storage.getThreads(rows.map((r) => r.latest.threadId))).map((t) => [t.id, t]));
    return rows
      .filter((r) => isChatProvider(r.latest.provider))
      .map(({ latest, unread }) => {
        const account = accounts.get(`${latest.provider}:${latest.accountEmail}`);
        return {
          id: latest.threadId,
          provider: latest.provider as ChatProvider,
          title: threads.get(latest.threadId)?.subject || latest.subject || "Conversation",
          label: account?.label ?? null,
          handle: latest.accountEmail ?? null,
          unread,
          lastMessage: {
            sender: latest.from.name ?? latest.from.address,
            text: latest.body,
            at: latest.receivedAt,
            fromBot: latest.direction === "outbound",
          },
        };
      });
  }

  /** Sends a reply into a conversation through the bot that's in it, and files it. */
  async send(threadId: string, text: string): Promise<Missive> {
    const body = text?.trim();
    if (!body) throw new BadRequestException("Nothing to send");
    const thread = await this.storage.getThread(threadId);
    if (!thread || !isChatProvider(thread.provider)) throw new NotFoundException("No such conversation");
    const [latest] = await this.storage.getThreadMissives(threadId);
    const connector = latest?.accountEmail ? await this.store.getByEmail(thread.provider, latest.accountEmail) : undefined;
    if (!connector) throw new BadRequestException("The bot for this conversation isn't connected any more");
    let sent: ChatMessage;
    try {
      sent = await this.sendThrough(connector, thread.provider, thread.providerThreadId, thread.subject ?? "", body);
    } catch (e) {
      throw new BadRequestException(`${CHAT_PROVIDER_NAMES[thread.provider]} didn't send it: ${safeError(e)}`);
    }
    const provider = thread.provider;
    return this.inOrder(threadId, () => this.save(connector, provider, sent, threadId));
  }

  private async sendThrough(connector: StoredConnector, provider: ChatProvider, chatId: string, title: string, text: string): Promise<ChatMessage> {
    if (provider === "wecom") return wecomSend(connector.tokens as WecomCredentials, chatId, title, text);
    if (provider === "zalo") {
      const c = connector.tokens as ZaloCredentials;
      const token = await this.zaloAccessToken(connector.id);
      if (!token) throw new Error("This Zalo OA isn't connected any more");
      const messageId = await new ZaloApi(c.appId, c.appSecret).sendText(token, chatId, text);
      return { chatId, chatTitle: title, messageId: messageId || `sent:${Date.now()}`, senderId: c.oaId, senderName: "You", text, fromBot: true, at: new Date().toISOString() };
    }
    const { botToken, botId } = connector.tokens as BotCredentials;
    return sendChat(provider as BotProvider, botToken, botId, chatId, title, text);
  }
}
