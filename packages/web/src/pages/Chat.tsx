import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertCircle, ArrowLeft, Loader2, MessagesSquare, SendHorizontal, Settings as SettingsIcon } from "lucide-react";
import type { Missive } from "@theaiinc/missive-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiJson, retryDelay, retryServerErrors } from "@/lib/api";
import { cn } from "@/lib/utils";

/** A conversation from a connected chat app (GET /api/v1/chat-apps/conversations). */
export type ChatConversation = {
  id: string;
  provider: keyof typeof CHAT_APP_NAMES;
  title: string;
  /** What the bot's connection is called, e.g. the project it's for. */
  label: string | null;
  handle: string | null;
  unread: number;
  lastMessage: { sender: string; text: string; at: string; fromBot: boolean };
};

export const CHAT_APP_NAMES = { telegram: "Telegram", discord: "Discord", wecom: "WeCom", zalo: "Zalo" } as const;
const APP_STYLE = {
  telegram: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  discord: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  wecom: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  zalo: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
} as const;

/** New messages show up without a refresh. */
const POLL_MS = 5000;

function when(iso: string): string {
  const date = new Date(iso);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (date.toDateString() === new Date().toDateString()) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function AppBadge({ provider }: { provider: ChatConversation["provider"] }) {
  return <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", APP_STYLE[provider])}>{CHAT_APP_NAMES[provider]}</span>;
}

export function useChatConversations() {
  return useQuery<ChatConversation[]>({
    queryKey: ["chat-conversations"],
    queryFn: () => apiJson<ChatConversation[]>("/api/v1/chat-apps/conversations"),
    refetchInterval: POLL_MS,
    retry: retryServerErrors,
    retryDelay,
  });
}

function ConversationList({ conversations, activeId }: { conversations: ChatConversation[]; activeId?: string }) {
  return (
    <ul aria-label="Conversations">
      {conversations.map((c) => (
        <li key={c.id}>
          <Link
            to={`/chat/${encodeURIComponent(c.id)}`}
            aria-current={c.id === activeId ? "page" : undefined}
            className={cn(
              "block px-4 py-3 border-b border-border hover:bg-accent/50 transition-colors",
              c.id === activeId && "bg-accent",
            )}
          >
            <div className="flex items-center gap-2">
              <AppBadge provider={c.provider} />
              {c.label && (
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  {c.label}
                </Badge>
              )}
              <span className={cn("flex-1 min-w-0 truncate text-sm text-foreground", c.unread > 0 && "font-semibold")}>{c.title}</span>
              <time dateTime={c.lastMessage.at} className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {when(c.lastMessage.at)}
              </time>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <p className="flex-1 min-w-0 truncate text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">{c.lastMessage.fromBot ? "You" : c.lastMessage.sender}:</span> {c.lastMessage.text}
              </p>
              {c.unread > 0 && (
                <span className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground" aria-label={`${c.unread} unread`}>
                  {c.unread}
                </span>
              )}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Conversation({ conversation }: { conversation: ChatConversation }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const { data: messages, isLoading, isError } = useQuery<Missive[]>({
    queryKey: ["chat-messages", conversation.id],
    queryFn: async () => (await apiJson<Missive[]>(`/api/v1/thread/${encodeURIComponent(conversation.id)}/missives`)).slice().reverse(),
    refetchInterval: POLL_MS,
    retry: retryServerErrors,
    retryDelay,
  });

  // Opening a conversation (or a new message arriving in it) reads it.
  useEffect(() => {
    if (!conversation.unread) return;
    void fetch(`/api/v1/thread/${encodeURIComponent(conversation.id)}/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ read: true }),
    }).then(() => queryClient.invalidateQueries({ queryKey: ["chat-conversations"] }));
  }, [conversation.id, conversation.unread, queryClient]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages?.length]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await apiJson(`/api/v1/chat-apps/conversations/${encodeURIComponent(conversation.id)}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: body }),
      });
      setText("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["chat-messages", conversation.id] }),
        queryClient.invalidateQueries({ queryKey: ["chat-conversations"] }),
      ]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send it. Try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="h-full flex flex-col min-w-0">
      <div className="pl-12 pr-4 md:px-6 py-3 border-b border-border bg-card flex items-center gap-2">
        <Link to="/chat" className="md:hidden -ml-1 p-1 text-muted-foreground hover:text-foreground" aria-label="All conversations">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <AppBadge provider={conversation.provider} />
        {conversation.label && (
          <Badge variant="secondary" className="text-[10px]">
            {conversation.label}
          </Badge>
        )}
        <h2 className="flex-1 min-w-0 truncate text-sm font-semibold text-foreground">{conversation.title}</h2>
        {conversation.handle && <span className="hidden sm:inline text-xs text-muted-foreground truncate">via {conversation.handle}</span>}
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 space-y-3" aria-live="polite">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            <span className="text-sm">Loading messages…</span>
          </div>
        ) : isError ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Couldn't load this conversation.</p>
        ) : (
          messages?.map((m) => {
            const mine = m.direction === "outbound";
            return (
              <div key={m.id} className={cn("flex flex-col max-w-[85%] md:max-w-[70%]", mine ? "ml-auto items-end" : "items-start")}>
                <span className="text-[11px] text-muted-foreground mb-0.5">
                  {mine ? "You" : m.from.name || m.from.address} · {when(m.receivedAt)}
                </span>
                <div
                  data-selectable
                  className={cn(
                    "rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words",
                    mine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
                  )}
                >
                  {m.body}
                </div>
              </div>
            );
          })
        )}
        <div ref={bottom} />
      </div>

      {/* Right padding keeps Send clear of the floating AI assistant button (ChatWidget, bottom-right). */}
      <form onSubmit={send} className="border-t border-border bg-card pl-4 md:pl-6 pr-[4.75rem] py-3 flex items-end gap-2">
        <label htmlFor="chat-reply" className="sr-only">
          Reply in {conversation.title}
        </label>
        <textarea
          id="chat-reply"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          rows={1}
          placeholder={`Message via ${CHAT_APP_NAMES[conversation.provider]}`}
          className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring max-h-40"
        />
        <Button type="submit" size="sm" disabled={!text.trim() || sending} aria-label="Send">
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <SendHorizontal className="w-4 h-4" />}
        </Button>
      </form>
    </div>
  );
}

/** Conversations from the chat apps connected in Settings (Telegram, Discord, WeCom, Zalo). */
export function Chat() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { data: conversations, isLoading, isError } = useChatConversations();
  const active = conversations?.find((c) => c.id === id);

  // A conversation that's gone (its bot disconnected) falls back to the list.
  useEffect(() => {
    if (id && conversations && !active) navigate("/chat", { replace: true });
  }, [id, conversations, active, navigate]);

  return (
    <div className="h-full flex">
      <div className={cn("flex flex-col w-full md:w-80 lg:w-96 md:border-r border-border min-h-0", active && "hidden md:flex")}>
        <div className="pl-12 pr-4 md:px-4 py-4 border-b border-border bg-card">
          <h2 className="text-lg font-semibold text-foreground">Chat</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Telegram, Discord, WeCom and Zalo, from the apps you connected.</p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              <span className="text-sm">Loading conversations…</span>
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <AlertCircle className="w-8 h-8 mb-3 opacity-40" />
              <p className="text-sm">Couldn't load your chats</p>
            </div>
          ) : !conversations?.length ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-muted-foreground text-center">
              <MessagesSquare className="w-8 h-8 mb-3 opacity-40" />
              <p className="text-sm font-medium">No conversations yet</p>
              <p className="text-xs opacity-70 mt-1 max-w-xs">
                Connect a chat app in Settings: a Telegram or Discord bot, WeCom, or a Zalo Official Account.
              </p>
              <Button asChild variant="outline" size="sm" className="mt-4">
                <Link to="/settings#chat-apps">
                  <SettingsIcon className="w-3.5 h-3.5 mr-1" />
                  Connect a bot
                </Link>
              </Button>
            </div>
          ) : (
            <ConversationList conversations={conversations} activeId={active?.id} />
          )}
        </div>
      </div>
      <div className={cn("flex-1 min-w-0", !active && "hidden md:block")}>
        {active ? (
          <Conversation key={active.id} conversation={active} />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
            <MessagesSquare className="w-10 h-10 mb-3 opacity-30" />
            <p className="text-sm">Pick a conversation</p>
          </div>
        )}
      </div>
    </div>
  );
}
