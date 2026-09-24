import { Bell, X, CheckCheck, Mail, Sparkles, Loader2 } from "lucide-react";
import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NotificationItem, DigestInfo } from "@/hooks/useNotifications";

interface NotificationPanelProps {
  notifications: NotificationItem[];
  unreadCount: number;
  digest: DigestInfo | null;
  digestLoaded: boolean;
  markAllRead: () => void;
  dismissNotification: (id: string) => void;
  markRead: (id: string) => void;
}

export function NotificationPanel({
  notifications,
  unreadCount,
  digest,
  digestLoaded,
  markAllRead,
  dismissNotification,
  markRead,
}: NotificationPanelProps) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const handleClick = useCallback(
    (n: NotificationItem) => {
      if (!n.read) markRead(n.id);
      setOpen(false);
      navigate(n.threadId ? `/thread/${n.threadId}` : "/inbox");
    },
    [navigate, markRead]
  );

  const importanceLabel = (imp: string) => {
    switch (imp) {
      case "high":
        return { dot: "bg-red-500", text: "text-red-600 dark:text-red-400 font-medium" };
      case "medium":
        return { dot: "bg-blue-500", text: "text-blue-600 dark:text-blue-400" };
      default:
        return { dot: "bg-zinc-300 dark:bg-zinc-600", text: "text-muted-foreground" };
    }
  };

  return (
    <div className="relative">
      {/* Bell button */}
      <button
        onClick={() => setOpen(!open)}
        className="relative p-1.5 rounded-md hover:bg-accent transition-colors"
        title="Notifications"
      >
        <Bell className="w-4 h-4 text-muted-foreground" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />

          <div className="absolute right-0 top-full mt-2 w-80 z-50 bg-popover border border-border rounded-lg shadow-xl flex flex-col max-h-[calc(100vh-100px)]">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
              <div className="flex items-center gap-2">
                <Bell className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">
                  Notifications
                </span>
                {unreadCount > 0 && (
                  <span className="text-[10px] font-medium text-muted-foreground">
                    ({unreadCount} new)
                  </span>
                )}
              </div>
              {notifications.length > 0 && (
                <button
                  onClick={markAllRead}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <CheckCheck className="w-3 h-3" />
                  Mark all read
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              {/* AI Digest summary */}
              {digest ? (
                <div className="px-3 py-2.5 border-b border-border/50 bg-gradient-to-r from-primary/5 to-transparent">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Sparkles className="w-3 h-3 text-primary" />
                    <span className="text-[10px] font-semibold text-primary uppercase tracking-wider">
                      AI Summary
                    </span>
                  </div>
                  <div className="text-xs text-foreground leading-relaxed prose prose-sm prose-neutral dark:prose-invert max-w-none [&_p]:text-xs [&_p]:leading-relaxed [&_p]:my-0 [&_ul]:text-xs [&_ul]:my-0.5 [&_li]:text-xs [&_li]:my-0 [&_strong]:font-semibold [&_code]:text-[10px] [&_code]:bg-muted [&_code]:px-1 [&_code]:rounded">
                    <Markdown>{digest.summary}</Markdown>
                  </div>

                  {/* Digest items */}
                  {digest.items.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {digest.items.filter((i) => i.importance === "high" || i.importance === "medium").slice(0, 5).map((item, idx) => {
                        const imp = importanceLabel(item.importance);
                        return (
                          <button
                            key={idx}
                            onClick={() => {
                              setOpen(false);
                              navigate(`/thread/${item.threadId}`);
                            }}
                            className="w-full flex items-start gap-2 px-2 py-1.5 rounded hover:bg-accent/50 transition-colors text-left"
                          >
                            <span className={`w-1.5 h-1.5 rounded-full mt-1 flex-shrink-0 ${imp.dot}`} />
                            <div className="min-w-0 flex-1">
                              <p className="text-[11px] font-medium text-foreground truncate">
                                {item.subject}
                              </p>
                              <p className={`text-[10px] ${imp.text} truncate`}>
                                {item.sender} — {item.reason}
                              </p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : !digestLoaded ? (
                <div className="flex items-center justify-center py-3 text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin mr-1.5" />
                  <span className="text-[10px]">Loading digest...</span>
                </div>
              ) : null}

              {/* Notifications list */}
              {notifications.length === 0 ? (
                digest === null ? (
                  <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                    <Mail className="w-6 h-6 mb-2 opacity-40" />
                    <p className="text-xs">No notifications yet</p>
                    <p className="text-[10px] opacity-60">
                      New emails will appear here
                    </p>
                  </div>
                ) : null
              ) : (
                notifications.map((n) => (
                  <div
                    key={n.id}
                    onClick={() => handleClick(n)}
                    className={cn(
                      "flex items-start gap-2 px-3 py-2.5 border-b border-border/50 last:border-0 hover:bg-muted/50 transition-colors group cursor-pointer",
                      !n.read && "bg-muted/30"
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        {!n.read && (
                          <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
                        )}
                        <p
                          className={cn(
                            "text-xs truncate",
                            !n.read
                              ? "font-semibold text-foreground"
                              : "text-muted-foreground"
                          )}
                        >
                          {n.sender}
                        </p>
                      </div>
                      <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                        {n.subject}
                      </p>
                      {n.accountEmail && (
                        <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                          → {n.accountEmail}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        dismissNotification(n.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent transition-opacity flex-shrink-0 mt-0.5"
                    >
                      <X className="w-3 h-3 text-muted-foreground" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
