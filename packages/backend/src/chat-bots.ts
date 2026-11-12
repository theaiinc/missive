import { createHash } from "node:crypto";

/**
 * Chat apps (Telegram, Discord) reach Missive through a bot the person
 * creates and connects with its token. These are the parts that talk to each
 * app: a Telegram long-poll loop, a minimal Discord gateway client, sending,
 * and turning each app's message into one shape (ChatMessage).
 */

export type ChatProvider = "telegram" | "discord";
export const CHAT_PROVIDERS: ChatProvider[] = ["telegram", "discord"];
export const CHAT_PROVIDER_NAMES: Record<ChatProvider, string> = { telegram: "Telegram", discord: "Discord" };

/** One message, as Missive files it, whichever app it came from. */
export type ChatMessage = {
  chatId: string;
  /** The group, channel or person the conversation is with, e.g. "#general · Cinely HQ". */
  chatTitle: string;
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
  /** Sent by the bot itself (a reply from Missive, echoed back by the app). */
  fromBot: boolean;
  at: string;
};

/** The bot behind a connector, as its app reports it. */
export type BotIdentity = { id: string; handle: string };

/** A bot token the app refused: the connector needs a new one. */
export class BotAuthError extends Error {}

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 26);
/** Ids include the owner, so two people's bots in the same chat never share a row. */
export const chatThreadId = (userId: string, provider: ChatProvider, chatId: string) =>
  `t_${digest(`${userId}|${provider}|${chatId}`)}`;
export const chatMissiveId = (userId: string, provider: ChatProvider, chatId: string, messageId: string) =>
  `m_${digest(`${userId}|${provider}|${chatId}|${messageId}`)}`;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

// ── Telegram ──────────────────────────────────────────────

const TELEGRAM_API = "https://api.telegram.org";

async function telegramCall<T>(token: string, method: string, body?: object, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const json = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string } | null;
  if (res.status === 401 || res.status === 404) throw new BotAuthError("Telegram didn't accept this bot token");
  if (!json?.ok) throw new Error(json?.description ?? `Telegram ${method} failed (${res.status})`);
  return json.result as T;
}

export async function telegramIdentity(token: string): Promise<BotIdentity> {
  const me = await telegramCall<{ id: number; username: string }>(token, "getMe");
  return { id: String(me.id), handle: `@${me.username}` };
}

type TelegramUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
type TelegramChat = { id: number; type: string; title?: string; first_name?: string; last_name?: string; username?: string };
export type TelegramMessage = {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  text?: string;
  caption?: string;
  photo?: unknown;
  video?: unknown;
  voice?: unknown;
  audio?: unknown;
  document?: { file_name?: string };
  sticker?: { emoji?: string };
  animation?: unknown;
  video_note?: unknown;
  location?: unknown;
  contact?: unknown;
  poll?: { question?: string };
};

const fullName = (p: { first_name?: string; last_name?: string; username?: string; title?: string }) =>
  p.title || [p.first_name, p.last_name].filter(Boolean).join(" ") || (p.username ? `@${p.username}` : "");

/** What a message without text shows as, e.g. "[photo]". */
function telegramPlaceholder(m: TelegramMessage): string {
  if (m.photo) return "[photo]";
  if (m.video) return "[video]";
  if (m.animation) return "[GIF]";
  if (m.video_note) return "[video message]";
  if (m.voice) return "[voice message]";
  if (m.audio) return "[audio]";
  if (m.document) return `[file${m.document.file_name ? `: ${m.document.file_name}` : ""}]`;
  if (m.sticker) return m.sticker.emoji ? `[sticker ${m.sticker.emoji}]` : "[sticker]";
  if (m.location) return "[location]";
  if (m.contact) return "[contact]";
  if (m.poll) return `[poll${m.poll.question ? `: ${m.poll.question}` : ""}]`;
  return "";
}

export function fromTelegram(m: TelegramMessage, botId: string): ChatMessage | null {
  const placeholder = telegramPlaceholder(m);
  const caption = m.text ?? m.caption ?? "";
  const text = placeholder && caption ? `${placeholder} ${caption}` : caption || placeholder;
  if (!text) return null; // joins, pins, title changes, ...
  const sender = m.from ?? m.sender_chat;
  return {
    chatId: String(m.chat.id),
    chatTitle: m.chat.type === "private" ? fullName(m.chat) || "Direct message" : m.chat.title || String(m.chat.id),
    messageId: String(m.message_id),
    senderId: String(sender?.id ?? m.chat.id),
    senderName: (sender && fullName(sender)) || "Unknown",
    text,
    fromBot: String(m.from?.id ?? "") === botId,
    at: new Date(m.date * 1000).toISOString(),
  };
}

export async function telegramSend(token: string, chatId: string, text: string): Promise<TelegramMessage> {
  return telegramCall<TelegramMessage>(token, "sendMessage", { chat_id: chatId, text });
}

/** Long-polls Telegram for new messages until the signal aborts. */
export async function runTelegram(opts: {
  token: string;
  botId: string;
  signal: AbortSignal;
  onMessage: (m: ChatMessage) => Promise<void>;
  onError: (e: unknown) => void;
}): Promise<void> {
  let offset = 0;
  while (!opts.signal.aborted) {
    try {
      const updates = await telegramCall<{ update_id: number; message?: TelegramMessage; channel_post?: TelegramMessage }[]>(
        opts.token,
        "getUpdates",
        { offset, timeout: 25, allowed_updates: ["message", "channel_post"] },
        opts.signal,
      );
      for (const u of updates) {
        offset = u.update_id + 1;
        const raw = u.message ?? u.channel_post;
        const message = raw && fromTelegram(raw, opts.botId);
        if (message) await opts.onMessage(message);
      }
    } catch (e) {
      if (opts.signal.aborted) return;
      if (e instanceof BotAuthError) throw e;
      opts.onError(e);
      await sleep(5000, opts.signal);
    }
  }
}

// ── Discord ───────────────────────────────────────────────

const DISCORD_API = "https://discord.com/api/v10";
// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

async function discordCall<T>(token: string, path: string, body?: object): Promise<T> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bot ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new BotAuthError("Discord didn't accept this bot token");
  const json = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!res.ok) throw new Error(json?.message ?? `Discord ${path} failed (${res.status})`);
  return json as T;
}

type DiscordUser = { id: string; username: string; discriminator?: string; global_name?: string | null; bot?: boolean };
const discordHandle = (u: DiscordUser) => (u.discriminator && u.discriminator !== "0" ? `${u.username}#${u.discriminator}` : u.username);

export async function discordIdentity(token: string): Promise<BotIdentity> {
  const me = await discordCall<DiscordUser>(token, "/users/@me");
  return { id: me.id, handle: discordHandle(me) };
}

export type DiscordMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  member?: { nick?: string | null };
  content: string;
  timestamp: string;
  attachments?: { url: string; filename: string }[];
  sticker_items?: { name: string }[];
  webhook_id?: string;
};

/** The part of Node's built-in WebSocket (Node 22+) the gateway client uses. */
type GatewaySocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
};
const SOCKET_OPEN = 1;
function openSocket(url: string): GatewaySocket {
  const Socket = (globalThis as unknown as { WebSocket?: new (url: string) => GatewaySocket }).WebSocket;
  if (!Socket) throw new Error("This Node.js has no built-in WebSocket (needs Node 22+)");
  return new Socket(url);
}

/** Channel and server names, learnt from the gateway as it runs. */
export type DiscordNames = { channels: Map<string, string>; guilds: Map<string, string> };

export function fromDiscord(m: DiscordMessage, botId: string, names: DiscordNames): ChatMessage | null {
  const parts = [m.content, ...(m.attachments ?? []).map((a) => a.url), ...(m.sticker_items ?? []).map((s) => `[sticker ${s.name}]`)];
  const text = parts.filter(Boolean).join("\n");
  if (!text) return null; // embeds only, joins, ...
  const sender = m.member?.nick || m.author.global_name || m.author.username;
  let chatTitle: string;
  if (m.guild_id) {
    const channel = names.channels.get(m.channel_id);
    const guild = names.guilds.get(m.guild_id);
    chatTitle = `${channel ? `#${channel}` : "Channel"}${guild ? ` · ${guild}` : ""}`;
  } else {
    // A DM: the conversation is with whoever isn't the bot. The bot's own
    // echoes keep the title the chat already has (the thread isn't renamed).
    chatTitle = m.author.id === botId ? "Direct message" : m.author.global_name || m.author.username;
  }
  return {
    chatId: m.channel_id,
    chatTitle,
    messageId: m.id,
    senderId: m.author.id,
    senderName: sender,
    text,
    fromBot: m.author.id === botId,
    at: new Date(m.timestamp).toISOString(),
  };
}

export async function discordSend(token: string, channelId: string, text: string): Promise<DiscordMessage> {
  return discordCall<DiscordMessage>(token, `/channels/${channelId}/messages`, {
    content: text.slice(0, 2000),
    allowed_mentions: { parse: [] },
  });
}

/**
 * Keeps a Discord gateway connection open until the signal aborts, resuming
 * the session after drops. Only messages are used; everything else just keeps
 * the channel and server names current.
 */
export async function runDiscord(opts: {
  token: string;
  botId: string;
  signal: AbortSignal;
  onMessage: (m: ChatMessage) => Promise<void>;
  onError: (e: unknown) => void;
}): Promise<void> {
  const names: DiscordNames = { channels: new Map(), guilds: new Map() };
  const { url } = await discordCall<{ url: string }>(opts.token, "/gateway/bot");
  let seq: number | null = null;
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  let queue = Promise.resolve();

  while (!opts.signal.aborted) {
    const code = await new Promise<number>((resolve) => {
      const ws = openSocket(`${resumeUrl ?? url}/?v=10&encoding=json`);
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let acked = true;
      const send = (payload: object) => ws.readyState === SOCKET_OPEN && ws.send(JSON.stringify(payload));
      const stop = () => ws.close(1000);
      opts.signal.addEventListener("abort", stop);

      ws.addEventListener("message", (event) => {
        const { op, d, s, t } = JSON.parse(String(event.data));
        if (s != null) seq = s;
        if (op === 10) {
          heartbeat = setInterval(() => {
            if (!acked) return ws.close(4900); // zombie connection: reconnect and resume
            acked = false;
            send({ op: 1, d: seq });
          }, d.heartbeat_interval);
          if (sessionId) send({ op: 6, d: { token: opts.token, session_id: sessionId, seq } });
          else send({ op: 2, d: { token: opts.token, intents: DISCORD_INTENTS, properties: { os: "linux", browser: "missive", device: "missive" } } });
        } else if (op === 11) {
          acked = true;
        } else if (op === 1) {
          send({ op: 1, d: seq });
        } else if (op === 7) {
          ws.close(4901); // asked to reconnect: resume
        } else if (op === 9) {
          if (!d) sessionId = resumeUrl = null; // not resumable: identify afresh
          ws.close(4902);
        } else if (op === 0) {
          if (t === "READY") {
            sessionId = d.session_id;
            resumeUrl = d.resume_gateway_url;
          } else if (t === "GUILD_CREATE" || t === "GUILD_UPDATE") {
            names.guilds.set(d.id, d.name);
            for (const c of [...(d.channels ?? []), ...(d.threads ?? [])]) names.channels.set(c.id, c.name);
          } else if (t === "CHANNEL_CREATE" || t === "CHANNEL_UPDATE" || t === "THREAD_CREATE" || t === "THREAD_UPDATE") {
            if (d.name) names.channels.set(d.id, d.name);
          } else if (t === "MESSAGE_CREATE") {
            const message = fromDiscord(d, opts.botId, names);
            // One at a time, in order, so a conversation's messages never race each other.
            if (message) queue = queue.then(() => opts.onMessage(message)).catch(opts.onError);
          }
        }
      });
      ws.addEventListener("error", (e) => opts.onError(e));
      ws.addEventListener("close", (event) => {
        clearInterval(heartbeat);
        opts.signal.removeEventListener("abort", stop);
        resolve(event.code);
      });
    });

    if (opts.signal.aborted) return;
    if (code === 4004) throw new BotAuthError("Discord didn't accept this bot token");
    if (code === 4014) throw new BotAuthError("Turn on Message Content Intent for this bot in the Discord Developer Portal");
    if ([4010, 4011, 4012, 4013].includes(code)) throw new Error(`Discord closed the connection (${code})`);
    if (code === 4007 || code === 4009) sessionId = resumeUrl = null;
    await sleep(code === 1000 ? 1000 : 3000, opts.signal);
  }
}

// ── Either app ────────────────────────────────────────────

export function botIdentity(provider: ChatProvider, token: string): Promise<BotIdentity> {
  return provider === "telegram" ? telegramIdentity(token) : discordIdentity(token);
}

/** Sends `text` to a chat and returns the sent message, as Missive files it. */
export async function sendChat(provider: ChatProvider, token: string, botId: string, chatId: string, chatTitle: string, text: string): Promise<ChatMessage> {
  if (provider === "telegram") {
    const sent = await telegramSend(token, chatId, text);
    return { ...fromTelegram(sent, botId)!, chatTitle };
  }
  const sent = await discordSend(token, chatId, text);
  return { ...fromDiscord(sent, botId, { channels: new Map(), guilds: new Map() })!, chatTitle };
}
