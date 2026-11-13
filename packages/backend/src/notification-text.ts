import type { Missive } from "@theaiinc/missive-core";

/** What a notification says and where clicking it goes (push.service.ts, recent-missives). */
export interface NotificationText {
  title: string;
  body: string;
  /** A path on the site: /thread/:id for mail, /chat/:threadId for a chat. */
  url: string;
  /** One notification per conversation: a newer one replaces it. */
  tag: string;
}

export const PROVIDER_NAMES: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  gcal: "Google Calendar",
  imap: "Your mail server",
  telegram: "Telegram",
  discord: "Discord",
  wecom: "WeCom",
  zalo: "Zalo",
};

const BODY_MAX = 180;
const isBareId = (s: string) => /^\d{5,}$/.test(s);

function clip(text: string, max = BODY_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Who wrote a chat message, never a bare 19-digit id (an address is "zalo:5387…"). */
export function chatSender(m: Pick<Missive, "from" | "provider">): string {
  const app = PROVIDER_NAMES[m.provider] ?? m.provider;
  const name = m.from.name?.trim();
  if (name && !isBareId(name)) return name;
  const id = (name || m.from.address.split(":").pop() || "").trim();
  return id ? `${app} user ···${id.slice(-4)}` : `Someone on ${app}`;
}

/**
 * "Zalo · Neko Coffee" / "Zalo user ···4897: Is this in stock?". The
 * conversation is the chat's own title (a group, a channel), or, for a
 * one-to-one chat titled after the person, the connection it came through.
 */
export function chatNotification(m: Missive, opts: { connection?: string | null; unread?: number } = {}): NotificationText {
  const app = PROVIDER_NAMES[m.provider] ?? m.provider;
  const sender = chatSender(m);
  const title = m.subject?.trim();
  const isOneToOne = !title || isBareId(title) || title === sender || title === m.from.name?.trim();
  const conversation = isOneToOne ? opts.connection?.trim() : title;
  const more = opts.unread && opts.unread > 1 ? ` (${opts.unread} new)` : "";
  return {
    title: `${conversation ? `${app} · ${conversation}` : app}${more}`,
    body: `${sender}: ${clip(m.body ?? "") || "(no text)"}`,
    url: `/chat/${encodeURIComponent(m.threadId)}`,
    tag: `chat:${m.threadId}`,
  };
}

export function mailNotification(m: Missive): NotificationText {
  return {
    title: m.from.name || m.from.address,
    body: m.subject || "(no subject)",
    url: `/thread/${encodeURIComponent(m.threadId)}`,
    tag: `thread:${m.threadId}`,
  };
}
