import { createContext, useContext, type ReactNode } from "react";
import { useNotifications, type NotificationItem, type DigestInfo } from "./useNotifications";

interface NotificationContextValue {
  notifications: NotificationItem[];
  unreadCount: number;
  digest: DigestInfo | null;
  digestLoaded: boolean;
  markAllRead: () => void;
  dismissNotification: (id: string) => void;
  markRead: (id: string) => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const value = useNotifications();
  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotificationContext(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error("useNotificationContext must be used within a NotificationProvider");
  }
  return ctx;
}
