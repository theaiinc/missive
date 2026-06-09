import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useEffect, useRef, useState, useCallback } from "react";
import type { Missive, Folder } from "@theaiinc/missive-core";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Search as SearchIcon, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;
const SHORT_QUERY_WORDS = 4; // ≤ this many words → debounce auto-search
const DEBOUNCE_MS = 350;

function fetchFolders(): Promise<Folder[]> {
  return fetch("/api/v1/folders").then((r) => r.json());
}

function MissiveSkeleton() {
  return (
    <div className="flex items-start gap-4 px-8 py-4 border-b border-border">
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

  // ── Search state ──
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [semantic, setSemantic] = useState(false);
  const [semanticResult, setSemanticResult] = useState("");
  const [semanticLoading, setSemanticLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelDebounce = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  const doSemanticSearch = useCallback(async (query: string) => {
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
      });
      if (!res.ok) {
        setSemanticResult("AI search unavailable. Is LM Studio running?");
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
      setSemanticResult("Network error.");
    }
    setSemanticLoading(false);
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
  }, [searchQuery, doSearch, cancelDebounce]);

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
    queryKey: ["missives", folder, activeSearch],
    queryFn: async ({ pageParam = 0 }) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(pageParam),
      });
      if (folder !== "all") params.set("folder", folder);
      if (activeSearch) params.set("query", activeSearch);
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

  const folderName =
    folders?.find((f) => f.slug === folder)?.name ??
    folder.charAt(0).toUpperCase() + folder.slice(1);

  const allMissives = data?.pages.flatMap((p) => p.missives) ?? [];
  const total = data?.pages[0]?.total;

  // Infinite scroll sentinel
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { rootMargin: "400px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div className="h-full flex flex-col">
      {/* Header with integrated search */}
      <div className="px-8 py-4 border-b border-border bg-card space-y-3">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold text-foreground shrink-0">
            {folderName}
          </h2>

          {/* Search bar */}
          <div
            className={cn(
              "flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 transition-all duration-200",
              searchQuery || activeSearch || semantic
                ? "flex-1 ring-1 ring-primary"
                : "w-64 focus-within:w-80 focus-within:ring-1 focus-within:ring-primary"
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
                  ? "Ask AI about your communications..."
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
            <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
              {allMissives.length}
              {total > allMissives.length ? ` / ${total}` : ""}
            </span>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {/* Semantic search result banner */}
        {semantic && (semanticResult || semanticLoading) && (
          <div
            className={cn(
              "mx-8 mt-4 p-4 rounded-lg border",
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
          allMissives.map((missive) => (
            <button
              key={missive.id}
              onClick={() => navigate(`/thread/${missive.threadId}`)}
              className="w-full text-left px-8 py-4 border-b border-border hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <Avatar className="h-9 w-9 mt-0.5">
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
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                        {missive.channel}
                      </Badge>
                    </div>
                    <p className="text-sm text-foreground mt-0.5 truncate">
                      {missive.subject ?? "(no subject)"}
                    </p>
                    {missive.accountEmail && (
                      <p className="text-[11px] text-muted-foreground/70 mt-0.5 flex items-center gap-1">
                        <span>→</span>
                        <span className="truncate">{missive.accountEmail}</span>
                      </p>
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
                  {missive.classification && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                      {missive.classification}
                    </Badge>
                  )}
                </div>
              </div>
            </button>
          ))}

        {/* Infinite scroll sentinel */}
        {!semantic && (
          <div ref={sentinelRef} className="flex items-center justify-center py-6">
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
