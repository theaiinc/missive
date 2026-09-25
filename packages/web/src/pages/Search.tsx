import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { SearchResult, Missive } from "@theaiinc/missive-core";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Search as SearchIcon } from "lucide-react";

export function Search() {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ["search", query],
    queryFn: async (): Promise<SearchResult> => {
      const res = await fetch(
        `/api/v1/search?query=${encodeURIComponent(query)}&limit=50`
      );
      return res.json();
    },
    enabled: query.length > 0,
  });

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 sm:px-8 py-4 border-b border-border bg-card space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Search</h2>
        <Input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search all communications..."
          autoFocus
          className="w-full"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {!query && (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <SearchIcon className="w-12 h-12 mb-3 opacity-50" />
            <p className="text-sm">
              Type a query to search across all your communications
            </p>
          </div>
        )}

        {isLoading && (
          <div className="px-4 sm:px-8 py-8">
            <p className="text-sm text-muted-foreground animate-pulse">
              Searching...
            </p>
          </div>
        )}

        {data?.missives.map((missive: Missive) => (
          <button
            key={missive.id}
            onClick={() => navigate(`/thread/${missive.threadId}`)}
            className="w-full text-left px-4 sm:px-8 py-4 border-b border-border hover:bg-accent/50 transition-colors"
          >
            <div className="flex items-start gap-3">
              <Avatar className="h-8 w-8 mt-0.5">
                <AvatarFallback className="text-xs bg-muted text-muted-foreground">
                  {missive.from.name?.[0]?.toUpperCase() ??
                    missive.from.address[0]?.toUpperCase() ??
                    "?"}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">
                    {missive.from.name ?? missive.from.address}
                  </span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap ml-2">
                    {new Date(missive.receivedAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-sm text-foreground mt-0.5">
                  {missive.subject}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {missive.body}
                </p>
              </div>
            </div>
          </button>
        ))}

        {data && data.missives.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            <p className="text-sm">
              No results found for "<span className="font-medium">{query}</span>"
            </p>
          </div>
        )}
      </div>
    </div>
  );
}