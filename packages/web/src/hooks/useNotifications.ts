import { useEffect, useRef, useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { refreshPush } from "@/lib/push";

export interface RecentMissive {
  id: string;
  threadId?: string;
  channel?: string;
  direction?: "inbound" | "outbound";
  subject?: string;
  from: { name?: string; address: string };
  body?: string;
  accountEmail?: string;
  receivedAt?: string;
  createdAt?: string;
  /** What to say about it (backend notification-text.ts); missing from an older server. */
  notification?: { title: string; body: string; url: string; tag: string };
}

export interface NotificationItem {
  id: string;
  threadId?: string;
  /** Where opening it goes: the thread, or the Chat page for a chat message. */
  href: string;
  sender: string;
  subject: string;
  accountEmail?: string;
  timestamp: number;
  read: boolean;
}

export interface DigestInfo {
  id: string;
  summary: string;
  items: {
    threadId: string;
    subject: string;
    sender: string;
    importance: "high" | "medium" | "low";
    reason: string;
    classification: string;
  }[];
  createdAt: string;
}

const LS_KEY = "missive_last_seen";
const POLL_INTERVAL = 30_000; // 30 seconds
const MAX_NOTIFICATIONS = 50;

function getLastSeen(): string {
  return localStorage.getItem(LS_KEY) ?? new Date(0).toISOString();
}

function setLastSeen(ts: string) {
  localStorage.setItem(LS_KEY, ts);
}

export function useNotifications() {
  const unreadRef = useRef(0);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [digest, setDigest] = useState<DigestInfo | null>(null);
  const [digestLoaded, setDigestLoaded] = useState(false);
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // A notification clicked: the service worker (public/sw.js) or the desktop
  // app (desktop notifications.js) asks this page to open what it was about.
  useEffect(() => {
    const open = (url: unknown) => {
      if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) return;
      window.focus();
      navigateRef.current(url);
    };
    const onWorker = (e: MessageEvent) => {
      if (e.data?.type === "missive:open") open(e.data.url);
    };
    const onDesktop = (e: Event) => open((e as CustomEvent<string>).detail);
    navigator.serviceWorker?.addEventListener("message", onWorker);
    window.addEventListener("missive:open", onDesktop);
    return () => {
      navigator.serviceWorker?.removeEventListener("message", onWorker);
      window.removeEventListener("missive:open", onDesktop);
    };
  }, []);

  // With push on (lib/push.ts), the service worker shows system
  // notifications, even with Missive closed; the page only shows toasts.
  const pushOnRef = useRef(false);
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then(() => refreshPush()).then((on) => { pushOnRef.current = on; });
    } else {
      refreshPush().then((on) => { pushOnRef.current = on; });
    }
  }, []);

  const pollDigest = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/digest");
      if (!res.ok) return;
      const data: DigestInfo = await res.json();
      if (data?.id) {
        setDigest(data);
      } else {
        setDigest(null);
      }
      setDigestLoaded(true);
    } catch {
      // Silently ignore
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const since = getLastSeen();
      const res = await fetch(
        `/api/v1/recent-missives?since=${encodeURIComponent(since)}&limit=5`
      );
      if (!res.ok) return;

      const data: { missives: RecentMissive[] } = await res.json();
      // What you sent yourself (a reply from Missive) isn't news.
      data.missives = (data.missives ?? []).filter((m) => m.direction !== "outbound");
      if (!data.missives.length) {
        setLastSeen(new Date().toISOString());
        return;
      }

      // Update last seen to the newest message
      const newest = data.missives.reduce((a, b) =>
        a.id > b.id ? a : b
      );
      setLastSeen(new Date().toISOString());

      // Build notification items from new missives
      const items: NotificationItem[] = data.missives.map((msg) => ({
        id: msg.id,
        threadId: msg.threadId,
        href: describe(msg).url,
        sender: describe(msg).title,
        subject: describe(msg).body,
        accountEmail: msg.accountEmail,
        timestamp: new Date(msg.receivedAt ?? msg.createdAt ?? Date.now()).getTime(),
        read: false,
      }));

      setNotifications((prev) => {
        const existing = new Set(prev.map((n) => n.id));
        const newItems = items.filter((n) => !existing.has(n.id));
        return [...newItems, ...prev].slice(0, MAX_NOTIFICATIONS);
      });

      // Update unread count
      unreadRef.current += items.length;
      setUnreadCount(unreadRef.current);
      updateTitleBadge(unreadRef.current);

      // Toasts and system notifications: one per conversation, the newest
      // (they come newest first), so a burst of chat messages is one alert.
      const shown = new Set<string>();
      for (const msg of data.missives) {
        const n = describe(msg);
        if (shown.has(n.tag)) continue;
        shown.add(n.tag);

        toast(n.title, {
          description: n.body,
          action: { label: "View", onClick: () => navigateRef.current(n.url) },
          duration: 5000,
        });

        if (!pushOnRef.current && "Notification" in window && Notification.permission === "granted") {
          const note = new Notification(n.title, { body: n.body, tag: n.tag, icon: "/missive.svg", data: { url: n.url } });
          note.onclick = () => {
            window.focus();
            navigateRef.current(n.url);
            note.close();
          };
        }
      }
    } catch {
      // Silently ignore polling errors
    }
  }, []);

  // Reset unread when user navigates to inbox
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        clearUnread();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  useEffect(() => {
    // Initial poll after a short delay
    const initialTimer = setTimeout(() => {
      poll();
      pollDigest();
    }, 5_000);
    pollingRef.current = setInterval(() => {
      poll();
      pollDigest();
    }, POLL_INTERVAL);

    return () => {
      clearTimeout(initialTimer);
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [poll, pollDigest]);

  const clearUnread = useCallback(() => {
    unreadRef.current = 0;
    setUnreadCount(0);
    updateTitleBadge(0);
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications([]);
    setLastSeen(new Date().toISOString());
    clearUnread();
  }, [clearUnread]);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const markRead = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  return {
    notifications,
    unreadCount,
    digest,
    digestLoaded,
    clearUnread,
    markAllRead,
    dismissNotification,
    markRead,
  };
}

/** The server's words for it, or the same from what's at hand (an older server). */
function describe(m: RecentMissive): { title: string; body: string; url: string; tag: string } {
  if (m.notification) return m.notification;
  const sender = m.from.name ?? m.from.address;
  if (m.channel === "chat") return { title: m.subject || sender, body: `${sender}: ${m.body ?? ""}`, url: missiveHref(m), tag: `chat:${m.threadId}` };
  const label = m.accountEmail ? ` [${m.accountEmail}]` : "";
  return { title: `${sender}${label}`, body: m.subject ?? "(no subject)", url: missiveHref(m), tag: `thread:${m.threadId ?? m.id}` };
}

/** A chat message (Telegram, Discord) opens on the Chat page; anything else on its thread. */
function missiveHref(m: RecentMissive): string {
  if (!m.threadId) return "/inbox";
  return m.channel === "chat" ? `/chat/${m.threadId}` : `/thread/${m.threadId}`;
}

function updateTitleBadge(count: number) {
  if (count > 0) {
    document.title = `(${count}) Missive`;
  } else {
    document.title = "Missive";
  }
}
