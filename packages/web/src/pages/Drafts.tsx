import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AlertCircle, FilePen, Loader2, Paperclip, Reply, Trash2 } from "lucide-react";
import { draftFromStored, useCompose } from "@/components/Compose";
import { draftTitle, type StoredDraft } from "@/lib/draftSaver";

/** Your saved drafts, newest first (GET /api/v1/drafts). */
export function useDrafts() {
  return useQuery<StoredDraft[]>({
    queryKey: ["drafts"],
    queryFn: async () => {
      const res = await fetch("/api/v1/drafts");
      if (!res.ok) throw new Error(`Couldn't load your drafts (${res.status})`);
      return res.json();
    },
  });
}

function when(iso: string): string {
  const date = new Date(iso);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (date.toDateString() === new Date().toDateString()) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

/** "To a, b · Cc c", or that there's no one yet. */
function recipients(d: StoredDraft): string {
  const p = d.payload;
  const parts = [p.to?.trim() && `To ${p.to.trim()}`, p.cc?.trim() && `Cc ${p.cc.trim()}`, p.bcc?.trim() && `Bcc ${p.bcc.trim()}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No recipients yet";
}

export function Drafts() {
  const { data: drafts, isLoading, isError } = useDrafts();
  const compose = useCompose();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const open = (d: StoredDraft) => {
    // A reply's draft opens on its thread, so what it answers is right there.
    if (d.payload.replyTo && d.payload.threadId) navigate(`/thread/${encodeURIComponent(d.payload.threadId)}`);
    compose(draftFromStored(d));
  };

  const discard = async (d: StoredDraft) => {
    if (!window.confirm(`Discard "${draftTitle(d.payload)}"? It will be deleted.`)) return;
    const res = await fetch(`/api/v1/drafts/${encodeURIComponent(d.id)}`, { method: "DELETE" }).catch(() => null);
    if (!res || (!res.ok && res.status !== 403)) {
      toast.error("Couldn't discard the draft. Try again.");
      return;
    }
    queryClient.setQueryData<StoredDraft[]>(["drafts"], (list) => list?.filter((x) => x.id !== d.id));
    void queryClient.invalidateQueries({ queryKey: ["drafts"] });
  };

  return (
    <div className="h-full flex flex-col">
      <div className="pl-12 pr-4 md:px-8 py-4 border-b border-border bg-card">
        <h2 className="text-lg font-semibold text-foreground">Drafts</h2>
        <p className="text-xs text-muted-foreground mt-0.5">What you were writing, saved as you go. Open one to carry on.</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            <span className="text-sm">Loading drafts…</span>
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <AlertCircle className="w-8 h-8 mb-3 opacity-40" />
            <p className="text-sm">Couldn't load your drafts</p>
            <p className="text-xs opacity-60 mt-1">Try refreshing the page</p>
          </div>
        ) : !drafts?.length ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <FilePen className="w-8 h-8 mb-3 opacity-40" />
            <p className="text-sm font-medium">No drafts</p>
            <p className="text-xs opacity-60 mt-1 max-w-xs text-center">A message you start and don't send is kept here.</p>
          </div>
        ) : (
          <ul aria-label="Drafts">
            {drafts.map((d) => (
              <li key={d.id} className="flex items-stretch border-b border-border hover:bg-accent/50 transition-colors">
                <button type="button" onClick={() => open(d)} className="flex-1 min-w-0 text-left px-4 md:px-8 py-3">
                  <div className="flex items-baseline gap-3">
                    <span className="flex-1 min-w-0 truncate text-sm font-medium text-foreground">
                      {d.payload.replyTo && <Reply className="inline w-3.5 h-3.5 mr-1 -mt-0.5 text-muted-foreground" aria-label="Reply" />}
                      {draftTitle(d.payload)}
                    </span>
                    <time dateTime={d.updatedAt} title={new Date(d.updatedAt).toLocaleString()} className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {when(d.updatedAt)}
                    </time>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{recipients(d)}</p>
                  <p className="mt-0.5 flex items-center gap-2 truncate text-xs text-muted-foreground">
                    <span className="truncate">From {d.payload.from ?? d.mailbox}</span>
                    {!!d.payload.attachments?.length && (
                      <span className="shrink-0 inline-flex items-center gap-0.5">
                        <Paperclip className="w-3 h-3" />
                        {d.payload.attachments.length}
                      </span>
                    )}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => void discard(d)}
                  className="shrink-0 px-4 md:px-6 text-muted-foreground hover:text-destructive"
                  title="Discard draft"
                  aria-label={`Discard draft ${draftTitle(d.payload)}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
