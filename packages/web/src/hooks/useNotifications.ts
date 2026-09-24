import { useEffect, useRef, useCallback, useState } from "react";
import { toast } from "sonner";

export interface RecentMissive {
  id: string;
  threadId?: string;
  subject?: string;
  from: { name?: string; address: string };
  body?: string;
  accountEmail?: string;
  receivedAt?: string;
  createdAt?: string;
}

export interface NotificationItem {
  id: string;
  threadId?: string;
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

  // Request browser notification permission once
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
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
      if (!data.missives?.length) return;

      // Update last seen to the newest message
      const newest = data.missives.reduce((a, b) =>
        a.id > b.id ? a : b
      );
      setLastSeen(new Date().toISOString());

      // Build notification items from new missives
      const items: NotificationItem[] = data.missives.map((msg) => ({
        id: msg.id,
        threadId: msg.threadId,
        sender: msg.from.name ?? msg.from.address,
        subject: msg.subject ?? "(no subject)",
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

      // Show toasts and browser notifications
      for (const msg of data.missives) {
        const sender = msg.from.name ?? msg.from.address;
        const subject = msg.subject ?? "(no subject)";
        const label = msg.accountEmail ? ` [${msg.accountEmail}]` : "";

        toast(`${sender}${label}`, {
          description: subject,
          action: {
            label: "View",
            onClick: () => {
              window.location.href = msg.threadId
                ? `/thread/${msg.threadId}`
                : "/inbox";
            },
          },
          duration: 5000,
        });

        // Browser notification
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification(`Missive: ${sender}`, {
            body: subject,
            icon: "/missive.svg",
          });
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

function updateTitleBadge(count: number) {
  if (count > 0) {
    document.title = `(${count}) Missive`;
  } else {
    document.title = "Missive";
  }
}
