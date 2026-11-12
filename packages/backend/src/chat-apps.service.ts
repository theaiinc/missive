import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { Missive, Thread } from "@theaiinc/missive-core";
import { ConnectorStore, type StoredConnector } from "./connector.store";
import { StorageService } from "./storage/storage.service";
import { UsersService } from "./users.service";
import { requireUser, runAsUser, type RequestUser } from "./request-context";
import { safeError } from "./log-safe";
import {
  BotAuthError,
  CHAT_PROVIDERS,
  botIdentity,
  chatMissiveId,
  chatThreadId,
  runDiscord,
  runTelegram,
  sendChat,
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
};

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

  constructor(
    private readonly store: ConnectorStore,
    private readonly storage: StorageService,
    private readonly users: UsersService,
    private readonly events: EventEmitter2,
  ) {}

  private get enabled() {
    return process.env.MISSIVE_CHAT_BOTS !== "off" && process.env.NODE_ENV !== "test";
  }

  onModuleInit() {
    if (!this.enabled) return;
    // After migrations and the first sync have had a moment.
    this.bootTimer = setTimeout(() => void this.startAll().catch((e) => this.log.warn(`Couldn't start chat bots: ${safeError(e)}`)), 10_000);
  }

  onModuleDestroy() {
    clearTimeout(this.bootTimer);
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
  }

  private async startAll() {
    for (const user of await this.users.all()) {
      await runAsUser(user, async () => {
        for (const provider of CHAT_PROVIDERS) {
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
      running: this.running.has(c.id),
      needsReauth: c.status === "needs_reauth",
      lastError: c.lastError ?? null,
    }));
  }

  /** Checks the token with the app, stores it, and starts the bot. */
  async connect(provider: string, token: string, label: string): Promise<ChatAccount> {
    if (!isChatProvider(provider)) throw new BadRequestException("Chat apps are telegram and discord");
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

  async disconnect(id: string): Promise<void> {
    const connector = await this.store.get(id);
    if (!connector || !isChatProvider(connector.provider)) throw new NotFoundException("No such chat app connection");
    this.running.get(id)?.abort();
    this.running.delete(id);
    await this.store.remove(id);
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
    const { botToken, botId } = connector.tokens as BotCredentials;
    let sent: ChatMessage;
    try {
      sent = await sendChat(thread.provider, botToken, botId, thread.providerThreadId, thread.subject ?? "", body);
    } catch (e) {
      throw new BadRequestException(`${thread.provider === "telegram" ? "Telegram" : "Discord"} didn't send it: ${safeError(e)}`);
    }
    const provider = thread.provider;
    return this.inOrder(threadId, () => this.save(connector, provider, sent, threadId));
  }
}
