import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useEffect, useRef, useState, useCallback } from "react";
import type { Missive, Folder } from "@theaiinc/missive-core";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Search as SearchIcon, Sparkles, Archive, FolderOpen, Tag, ShieldAlert, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAccountColors } from "@/hooks/useAccountColors";
import { useEntityConfig, ConfigItem } from "@/hooks/useEntityConfig";
import { useNotificationContext } from "@/hooks/useNotificationContext";
import { useChat } from "@/hooks/useChat";
import { NotificationPanel } from "@/components/NotificationPanel";
import { colorOptions } from "@/hooks/useAccountColors";

// ── Deterministic org color generator (fallback) ──
const ORG_PALETTE = [
  { bg: "bg-violet-100 dark:bg-violet-900/30", text: "text-violet-700 dark:text-violet-300", dot: "bg-violet-500" },
  { bg: "bg-emerald-100 dark:bg-emerald-900/30", text: "text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
  { bg: "bg-orange-100 dark:bg-orange-900/30", text: "text-orange-700 dark:text-orange-300", dot: "bg-orange-500" },
  { bg: "bg-cyan-100 dark:bg-cyan-900/30", text: "text-cyan-700 dark:text-cyan-300", dot: "bg-cyan-500" },
  { bg: "bg-pink-100 dark:bg-pink-900/30", text: "text-pink-700 dark:text-pink-300", dot: "bg-pink-500" },
  { bg: "bg-teal-100 dark:bg-teal-900/30", text: "text-teal-700 dark:text-teal-300", dot: "bg-teal-500" },
  { bg: "bg-yellow-100 dark:bg-yellow-900/30", text: "text-yellow-700 dark:text-yellow-300", dot: "bg-yellow-500" },
  { bg: "bg-lime-100 dark:bg-lime-900/30", text: "text-lime-700 dark:text-lime-300", dot: "bg-lime-500" },
  { bg: "bg-fuchsia-100 dark:bg-fuchsia-900/30", text: "text-fuchsia-700 dark:text-fuchsia-300", dot: "bg-fuchsia-500" },
  { bg: "bg-rose-100 dark:bg-rose-900/30", text: "text-rose-700 dark:text-rose-300", dot: "bg-rose-500" },
];

function getItemStyle(name: string, configItems: ConfigItem[]) {
  const configured = configItems.find((i) => i.name === name);
  if (configured) {
    const opt = colorOptions[configured.colorIndex] ?? colorOptions[0];
    return { bg: opt.bg, text: opt.text, dot: opt.swatch };
  }
  // Fallback to hash-based palette
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash |= 0;
  }
  return ORG_PALETTE[Math.abs(hash) % ORG_PALETTE.length];
}

// ── Classification display system ──
const CLASSIFICATION_COLORS: Record<string, { bar: string; badge: string; bg: string }> = {
  invoice:     { bar: "border-l-green-500",      badge: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",      bg: "bg-green-50/30 dark:bg-green-950/10" },
  complaint:   { bar: "border-l-red-500",         badge: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",         bg: "bg-red-50/30 dark:bg-red-950/10" },
  lead:        { bar: "border-l-blue-500",        badge: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",       bg: "bg-blue-50/30 dark:bg-blue-950/10" },
  support:     { bar: "border-l-amber-500",       badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",     bg: "bg-amber-50/30 dark:bg-amber-950/10" },
  personal:    { bar: "border-l-purple-500",      badge: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",   bg: "bg-purple-50/30 dark:bg-purple-950/10" },
  notification:{ bar: "border-l-sky-500",         badge: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",         bg: "bg-sky-50/30 dark:bg-sky-950/10" },
  newsletter:  { bar: "border-l-zinc-400",        badge: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800/30 dark:text-zinc-400",       bg: "bg-zinc-50/30 dark:bg-zinc-900/10" },
  meeting:     { bar: "border-l-indigo-500",      badge: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",   bg: "bg-indigo-50/30 dark:bg-indigo-950/10" },
  spam:        { bar: "border-l-rose-500",        badge: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",       bg: "bg-rose-50/30 dark:bg-rose-950/10" },
};

function getClassificationStyle(classification?: string) {
  if (!classification) return null;
  return CLASSIFICATION_COLORS[classification.toLowerCase()] ?? {
    bar: "border-l-muted-foreground",
    badge: "bg-muted text-muted-foreground",
    bg: "",
  };
}

const PAGE_SIZE = 20;
const SHORT_QUERY_WORDS = 4; // ≤ this many words → debounce auto-search
const DEBOUNCE_MS = 350;

function fetchFolders(): Promise<Folder[]> {
  return fetch("/api/v1/folders").then((r) => r.json());
}

function MissiveSkeleton() {
  return (
    <div className="flex items-start gap-4 px-4 sm:px-8 py-4 border-b border-border">
      <Skeleton className="h-9 w-9 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-3 w-64" />
        <Skeleton className="h-3 w-96" />
      </div>
      <Skeleton className="h-4 w-16" />
    </div>
  );
}

export function Inbox() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const folder = searchParams.get("folder") ?? "inbox";
  const { getColor } = useAccountColors();

  // ── Search state ──
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [orgFilter, setOrgFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [semantic, setSemantic] = useState(false);
  const [semanticResult, setSemanticResult] = useState("");
  const [semanticLoading, setSemanticLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const semanticAbortRef = useRef<AbortController | null>(null);

  const cancelDebounce = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  const doSemanticSearch = useCallback(async (query: string) => {
    // A new question replaces the one still streaming.
    semanticAbortRef.current?.abort();
    const abort = new AbortController();
    semanticAbortRef.current = abort;
    setSemanticLoading(true);
    setSemanticResult("");
    setActiveSearch(""); // clear regular search results

    try {
      const res = await fetch("/api/v1/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Search my communications for: "${query}". Summarize what you find based on the available context in my inbox. Be concise.`,
        }),
        signal: abort.signal,
      });
      if (!res.ok) {
        setSemanticResult("AI search is unavailable right now.");
        setSemanticLoading(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let content = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const json = trimmed.slice(6);
          try {
            const parsed = JSON.parse(json);
            if (parsed.done) break;
            if (parsed.content) {
              content += parsed.content;
              setSemanticResult(content);
            }
          } catch {}
        }
      }
    } catch {
      if (abort.signal.aborted) return;
      setSemanticResult("Network error.");
    }
    if (semanticAbortRef.current === abort) setSemanticLoading(false);
  }, []);

  const doSearch = useCallback(
    (query: string) => {
      cancelDebounce();
      if (semantic && query.trim()) {
        doSemanticSearch(query.trim());
      } else {
        setActiveSearch(query.trim());
      }
    },
    [semantic, doSemanticSearch, cancelDebounce]
  );

  // ── Debounced auto-search ──
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return;

    // AI search asks the model, so it runs only on Enter, never while typing.
    if (semantic) {
      cancelDebounce();
      return;
    }

    // Long query → don't auto-search (wait for Enter)
    if (trimmed.split(/\s+/).length > SHORT_QUERY_WORDS) {
      cancelDebounce();
      return;
    }

    cancelDebounce();
    debounceRef.current = setTimeout(() => {
      doSearch(trimmed);
    }, DEBOUNCE_MS);

    return () => cancelDebounce();
  }, [searchQuery, semantic, doSearch, cancelDebounce]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      const trimmed = searchQuery.trim();
      if (trimmed) {
        cancelDebounce();
        doSearch(trimmed);
      }
    }
    if (e.key === "Escape") {
      setSearchQuery("");
      setActiveSearch("");
      setSemanticResult("");
      searchInputRef.current?.blur();
    }
  };

  const clearSearch = () => {
    cancelDebounce();
    semanticAbortRef.current?.abort();
    setSemanticLoading(false);
    setSearchQuery("");
    setActiveSearch("");
    setSemanticResult("");
    searchInputRef.current?.focus();
  };

  const {
    data,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: ["missives", folder, activeSearch, orgFilter, projectFilter],
    queryFn: async ({ pageParam = 0 }) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(pageParam),
      });
      if (folder !== "all") params.set("folder", folder);
      if (activeSearch) params.set("query", activeSearch);
      if (orgFilter) params.set("organization", orgFilter);
      if (projectFilter) params.set("project", projectFilter);
      const res = await fetch(`/api/v1/search?${params}`);
      const json = await res.json();
      return { missives: json.missives as Missive[], total: json.total as number };
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, p) => sum + p.missives.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });

  const { data: folders } = useQuery({
    queryKey: ["folders"],
    queryFn: fetchFolders,
  });

  const allOrganizations = useEntityConfig("missive_managed_organizations");
  const allProjects = useEntityConfig("missive_managed_projects");

  const folderName =
    folders?.find((f) => f.slug === folder)?.name ??
    folder.charAt(0).toUpperCase() + folder.slice(1);

  const notifCtx = useNotificationContext();
  const { pushSystemMessage } = useChat();

  const [contextMenu, setContextMenu] = useState<{
    missive: Missive;
    x: number;
    y: number;
  } | null>(null);
  const [moveToOpen, setMoveToOpen] = useState(false);
  const contextRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, missive: Missive) => {
      e.preventDefault();
      e.stopPropagation();
      setMoveToOpen(false);
      setContextMenu({ missive, x: e.clientX, y: e.clientY });
    },
    []
  );

  // Phones have no right-click: holding a message for half a second opens the same menu.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressedOpen = useRef(false);
  const longPress = (missive: Missive) => ({
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      pressedOpen.current = false;
      const { clientX: x, clientY: y } = t;
      pressTimer.current = setTimeout(() => {
        pressedOpen.current = true;
        setMoveToOpen(false);
        setContextMenu({ missive, x, y });
        navigator.vibrate?.(10);
      }, 500);
    },
    onTouchMove: () => { if (pressTimer.current) clearTimeout(pressTimer.current); },
    onTouchEnd: (e: React.TouchEvent) => {
      if (pressTimer.current) clearTimeout(pressTimer.current);
      // The press opened the menu: don't also open the message.
      if (pressedOpen.current) e.preventDefault();
    },
  });

  const doArchive = useCallback(async (missive: Missive) => {
    const res = await fetch(`/api/v1/missive/${missive.id}/archive`, { method: "POST" });
    setContextMenu(null);
    const data = await res.json();
    if (data.autoMoved > 0) {
      const domain = missive.from.address.split("@")[1];
      pushSystemMessage(`📁 Moved **${data.autoMoved}** other message(s) from **${domain}** to **archived** based on your action.`);
    }
    window.location.reload();
  }, [pushSystemMessage]);

  const doUnarchive = useCallback(async (missive: Missive) => {
    const res = await fetch(`/api/v1/missive/${missive.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: "inbox" }),
    });
    setContextMenu(null);
    const data = await res.json();
    if (data.autoMoved > 0) {
      const domain = missive.from.address.split("@")[1];
      pushSystemMessage(`📁 Moved **${data.autoMoved}** other message(s) from **${domain}** back to **inbox** based on your action.`);
    }
    window.location.reload();
  }, [pushSystemMessage]);

  const doMove = useCallback(async (missive: Missive, folderSlug: string) => {
    const res = await fetch(`/api/v1/missive/${missive.id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: folderSlug }),
    });
    setContextMenu(null);
    setMoveToOpen(false);
    const data = await res.json();
    if (data.autoMoved > 0) {
      const domain = missive.from.address.split("@")[1];
      pushSystemMessage(`📁 Moved **${data.autoMoved}** other message(s) from **${domain}** to **${folderSlug}** based on your action.`);
    }
    window.location.reload();
  }, [pushSystemMessage]);

  const doSpam = useCallback(async (missive: Missive, spam: boolean) => {
    const res = await fetch(`/api/v1/missive/${missive.id}/spam`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spam }),
    });
    setContextMenu(null);
    setMoveToOpen(false);
    const data = await res.json();
    if (data.autoMoved > 0) {
      pushSystemMessage(
        spam
          ? `🛡️ Also moved **${data.autoMoved}** other message(s) from **${missive.from.address}** to **Spam**.`
          : `📥 Also moved **${data.autoMoved}** other message(s) from **${missive.from.address}** back to **Inbox**.`
      );
    }
    window.location.reload();
  }, [pushSystemMessage]);

  const allMissives = data?.pages.flatMap((p) => p.missives) ?? [];
  const total = data?.pages[0]?.total;

  // Infinite scroll sentinel
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const handleScroll = () => {
      if (hasNextPage && !isFetchingNextPage) {
        const threshold = 400;
        const scrolledToBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
        if (scrolledToBottom) {
          fetchNextPage();
        }
      }
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div className="h-full flex flex-col">
      {/* Header with integrated search */}
      <div className="px-4 sm:px-8 py-3 sm:py-4 border-b border-border bg-card space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 className="text-lg font-semibold text-foreground shrink-0 min-w-0 truncate">
            {folderName}
          </h2>

          {/* Search bar */}
          <div
            className={cn(
              // Phones: its own full-width row under the title; wider screens: inline.
              "order-last basis-full sm:order-none sm:basis-auto flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 transition-all duration-200 min-w-0",
              searchQuery || activeSearch || semantic
                ? "sm:flex-1 ring-1 ring-primary"
                : "sm:w-64 sm:focus-within:w-80 focus-within:ring-1 focus-within:ring-primary"
            )}
          >
            <SearchIcon
              className={cn(
                "w-4 h-4 shrink-0 transition-colors",
                semantic ? "text-purple-500" : "text-muted-foreground"
              )}
            />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                semantic
                  ? "Ask AI about your mail, then press Enter"
                  : "Search messages..."
              }
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none min-w-0"
            />

            {(searchQuery || activeSearch) && (
              <button
                onClick={clearSearch}
                className="text-xs text-muted-foreground hover:text-foreground shrink-0 px-1"
              >
                &times;
              </button>
            )}

            {/* Semantic toggle */}
            <button
              onClick={() => {
                setSemantic(!semantic);
                if (!semantic && searchQuery) {
                  doSearch(searchQuery);
                }
              }}
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium shrink-0 transition-colors",
                semantic
                  ? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
              title="Toggle AI semantic search"
            >
              <Sparkles className="w-3 h-3" />
              <span className="hidden sm:inline">AI</span>
            </button>
          </div>

          {/* Results count */}
          {!isLoading && !semantic && total != null && (
            <span className="hidden sm:inline text-xs text-muted-foreground shrink-0 whitespace-nowrap">
              {allMissives.length}
              {total > allMissives.length ? ` / ${total}` : ""}
            </span>
          )}

          {/* Organization filter */}
          {allOrganizations.items.length > 0 && (
            <select
              value={orgFilter}
              onChange={(e) => setOrgFilter(e.target.value)}
              className="text-xs bg-background border border-border rounded-md px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-primary shrink-0"
              title="Filter by organization"
            >
              <option value="">All orgs</option>
              {allOrganizations.items.map((item: ConfigItem) => {
                const style = getItemStyle(item.name, allOrganizations.items);
                return (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                );
              })}
            </select>
          )}

          {/* Project filter */}
          {allProjects.items.length > 0 && (
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="text-xs bg-background border border-border rounded-md px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-primary shrink-0"
              title="Filter by project"
            >
              <option value="">All projects</option>
              {allProjects.items.map((item: ConfigItem) => {
                const style = getItemStyle(item.name, allProjects.items);
                return (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                );
              })}
            </select>
          )}

          {/* Notification bell */}
          <div className="ml-auto">
            <NotificationPanel
              notifications={notifCtx.notifications}
              unreadCount={notifCtx.unreadCount}
              digest={notifCtx.digest}
              digestLoaded={notifCtx.digestLoaded}
              markAllRead={notifCtx.markAllRead}
              dismissNotification={notifCtx.dismissNotification}
              markRead={notifCtx.markRead}
            />
          </div>
        </div>
      </div>

      {/* List */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {/* Semantic search result banner */}
        {semantic && (semanticResult || semanticLoading) && (
          <div
            className={cn(
              "mx-4 sm:mx-8 mt-4 p-4 rounded-lg border",
              semanticResult
                ? "bg-purple-50 border-purple-200 dark:bg-purple-950/20 dark:border-purple-800"
                : "bg-muted border-border"
            )}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <Sparkles className="w-4 h-4 text-purple-500" />
              <span className="text-xs font-semibold text-purple-600 dark:text-purple-400">
                AI Semantic Search
              </span>
              {semanticLoading && (
                <span className="text-xs text-muted-foreground animate-pulse">
                  Thinking...
                </span>
              )}
            </div>
            <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
              {semanticResult || (
                <span className="text-muted-foreground italic">
                  Asking the AI about your messages...
                </span>
              )}
            </p>
          </div>
        )}

        {isLoading && (
          <div className="py-4 space-y-0">
            {Array.from({ length: 8 }).map((_, i) => (
              <MissiveSkeleton key={i} />
            ))}
          </div>
        )}

        {!isLoading && allMissives.length === 0 && !semantic && (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <svg
              className="w-12 h-12 mb-3 opacity-50"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={1}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
              />
            </svg>
            <p className="text-base font-medium">
              {activeSearch
                ? `No results for "${activeSearch}"`
                : "No messages yet"}
            </p>
            <p className="text-sm mt-1">
              {activeSearch
                ? "Try a different query or switch to AI search"
                : "Connect an account in Settings to get started"}
            </p>
          </div>
        )}

        {!semantic &&
          allMissives.map((missive) => {
            const clsStyle = getClassificationStyle(missive.classification);
            return (
            <button
              key={missive.id}
              onClick={() => navigate(`/thread/${missive.threadId}`)}
              onContextMenu={(e) => handleContextMenu(e, missive)}
              {...longPress(missive)}
              className={cn(
                "w-full text-left px-4 sm:px-8 py-3 sm:py-4 border-b border-border hover:bg-accent/50 transition-colors relative select-none sm:select-auto [-webkit-touch-callout:none]",
                clsStyle?.bg
              )}
            >
              {/* Classification color bar */}
              {clsStyle && (
                <div className={cn("absolute left-0 top-0 bottom-0 w-[3px]", clsStyle.bar)} />
              )}
              <div className="flex items-start justify-between gap-2 sm:gap-4">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <Avatar className="h-9 w-9 mt-0.5 shrink-0">
                    <AvatarFallback className="text-xs bg-muted text-muted-foreground">
                      {missive.from.name?.[0]?.toUpperCase() ??
                        missive.from.address[0]?.toUpperCase() ??
                        "?"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">
                        {missive.from.name ?? missive.from.address}
                      </span>
                      <Badge variant="secondary" className="hidden sm:inline-flex text-[10px] px-1.5 py-0 h-4">
                        {missive.channel}
                      </Badge>
                    </div>
                    <p className="text-sm text-foreground mt-0.5 truncate">
                      {missive.subject ?? "(no subject)"}
                    </p>
                    {missive.accountEmail && (
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <span
                          className={cn(
                            "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight",
                            getColor(missive.accountEmail).bg,
                            getColor(missive.accountEmail).text,
                          )}
                        >
                          {missive.accountEmail}
                        </span>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {missive.body}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 mt-1">
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(missive.receivedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  {missive.classification && clsStyle && (
                    <span className={cn(
                      "hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight",
                      clsStyle.badge
                    )}>
                      <Tag className="w-2.5 h-2.5" />
                      {missive.classification}
                    </span>
                  )}
                  {/* Organization indicators */}
                  {missive.organizations && missive.organizations.length > 0 && (
                    <div className="hidden md:flex items-center gap-1">
                      {missive.organizations.map((org) => {
                        const style = getItemStyle(org, allOrganizations.items);
                        return (
                          <span
                            key={org}
                            className={cn(
                              "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight",
                              style.bg,
                              style.text
                            )}
                            title={org}
                          >
                            <span className={cn("w-1.5 h-1.5 rounded-full", style.dot)} />
                            {org}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {/* Project indicators */}
                  {missive.projects && missive.projects.length > 0 && (
                    <div className="hidden md:flex items-center gap-1">
                      {missive.projects.map((proj) => {
                        const style = getItemStyle(proj, allProjects.items);
                        return (
                          <span
                            key={proj}
                            className={cn(
                              "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight",
                              style.bg,
                              style.text
                            )}
                            title={proj}
                          >
                            <span className={cn("w-1.5 h-1.5 rounded-full", style.dot)} />
                            {proj}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </button>
            );
          })}

        {/* Context menu */}
        {contextMenu && (
          <>
            {/* Backdrop — catches all clicks outside the menu */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => { setContextMenu(null); setMoveToOpen(false); }}
            />
            <div
              ref={contextRef}
              className="fixed z-50 min-w-[160px] bg-popover border border-border rounded-lg shadow-xl py-1 text-sm"
              // Kept on screen: a menu opened near the right or bottom edge (or by long-press on a phone) opens inward.
              style={{
                left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 200)),
                top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 140)),
              }}
            >
            <button
              onClick={() => folder === "archived" ? doUnarchive(contextMenu.missive) : doArchive(contextMenu.missive)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-foreground hover:bg-accent text-left"
            >
              <Archive className="w-3.5 h-3.5" />
              {folder === "archived" ? "Move to Inbox" : "Archive"}
            </button>
            <button
              onClick={() => doSpam(contextMenu.missive, folder !== "spam")}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-foreground hover:bg-accent text-left"
            >
              {folder === "spam" ? <ShieldCheck className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
              {folder === "spam" ? "Not spam" : "Mark as spam"}
            </button>
            <div className="relative">
              <button
                onClick={() => setMoveToOpen(!moveToOpen)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-foreground hover:bg-accent text-left"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                Move to...
              </button>
              {moveToOpen && folders && (
                <div className="absolute left-0 top-full mt-1 sm:left-full sm:top-0 sm:mt-0 sm:ml-1 min-w-[140px] max-h-[50vh] overflow-y-auto bg-popover border border-border rounded-lg shadow-xl py-1">
                  {folders
                    .filter((f) => f.slug !== folder && f.slug !== "all")
                    .map((f) => (
                      <button
                        key={f.slug}
                        onClick={() => doMove(contextMenu.missive, f.slug)}
                        className="w-full text-left px-3 py-1.5 text-foreground hover:bg-accent text-sm"
                      >
                        {f.name}
                      </button>
                    ))}
                </div>
              )}
            </div>
            </div>
          </>
        )}

        {/* Infinite scroll sentinel */}
        {!semantic && (
          <div className="flex items-center justify-center py-6">
            {isFetchingNextPage && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Loading more...
              </div>
            )}
            {!hasNextPage && !isLoading && allMissives.length > 0 && (
              <p className="text-xs text-muted-foreground">
                All {allMissives.length} messages loaded
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
