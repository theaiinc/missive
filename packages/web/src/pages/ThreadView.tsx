import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useRef, useEffect } from "react";
import type { Missive, Thread } from "@theaiinc/missive-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft } from "lucide-react";

async function fetchThread(
  id: string
): Promise<{ thread: Thread; missives: Missive[] }> {
  const [threadRes, missivesRes] = await Promise.all([
    fetch(`/api/v1/thread/${id}`),
    fetch(`/api/v1/thread/${id}/missives`),
  ]);
  return {
    thread: await threadRes.json(),
    missives: await missivesRes.json(),
  };
}

export function ThreadView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["thread", id],
    queryFn: () => fetchThread(id!),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <div className="h-full flex flex-col">
        <div className="px-8 py-4 border-b border-border bg-card space-y-3">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="flex-1 px-8 py-4 space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="border border-border rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
              <Skeleton className="h-16 w-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Thread Header */}
      <div className="px-8 py-4 border-b border-border bg-card">
        <div className="flex items-center gap-3 mb-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back
          </Button>
        </div>
        <h2 className="text-lg font-semibold text-foreground">
          {data?.thread.subject ?? "(no subject)"}
        </h2>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-sm text-muted-foreground">
            {data?.missives.length ?? 0} messages
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-sm text-muted-foreground truncate">
            {data?.thread.participants
              .map((p) => p.name ?? p.address)
              .join(", ")}
          </span>
        </div>
        {(() => {
          const accounts = [...new Set(data?.missives.map((m) => m.accountEmail).filter(Boolean) as string[])];
          if (accounts.length === 0) return null;
          return (
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Accounts:</span>
              {accounts.map((acct) => (
                <Badge key={acct} variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal">
                  {acct}
                </Badge>
              ))}
            </div>
          );
        })()}
      </div>

      {data?.thread.summary && (
        <div className="mx-8 mt-4 p-3 bg-primary/5 border border-primary/20 rounded-lg">
          <p className="text-xs font-medium text-primary mb-1">Summary</p>
          <p className="text-sm text-muted-foreground">{data.thread.summary}</p>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-8 py-4 space-y-4">
        {data?.missives.map((missive, index) => (
          <EmailCard key={missive.id} missive={missive} />
        ))}
      </div>
    </div>
  );
}

function EmailCard({ missive }: { missive: Missive }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!iframeRef.current || !missive.bodyHtml) return;
    const iframe = iframeRef.current;
    let retries = 0;
    const timer = setInterval(() => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) {
          const height = doc.documentElement.scrollHeight;
          if (height > 50) {
            iframe.style.minHeight = `${height}px`;
            clearInterval(timer);
          }
        }
      } catch {}
      retries++;
      if (retries > 20) clearInterval(timer);
    }, 200);
    return () => clearInterval(timer);
  }, [missive.bodyHtml]);

  return (
    <div className="border border-border rounded-lg bg-card">
      <div className="flex items-center justify-between p-4 pb-3">
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="text-xs bg-muted text-muted-foreground">
              {missive.from.name?.[0]?.toUpperCase() ??
                missive.from.address[0]?.toUpperCase() ??
                "?"}
            </AvatarFallback>
          </Avatar>
          <div>
            <p className="text-sm font-medium text-foreground">
              {missive.from.name ?? missive.from.address}
            </p>
            <p className="text-xs text-muted-foreground">
              {new Date(missive.receivedAt).toLocaleString()}
            </p>
            {missive.accountEmail && (
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                via {missive.accountEmail}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {missive.classification && (
            <Badge variant="secondary" className="text-[10px]">
              {missive.classification}
            </Badge>
          )}
          <Badge variant="outline" className="text-[10px]">
            {missive.channel}
          </Badge>
        </div>
      </div>
      <Separator />
      <div className="p-0">
        {missive.bodyHtml ? (
          <iframe
            ref={iframeRef}
            className="w-full border-0"
            style={{ minHeight: "200px" }}
            sandbox="allow-same-origin"
            title="Email body"
            srcDoc={wrapEmailHtml(missive.bodyHtml)}
          />
        ) : (
          <div className="px-4 py-3 text-sm text-foreground whitespace-pre-wrap leading-relaxed">
            {missive.body}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Wrap email HTML in a standalone document that preserves the email's
 * own styles while adding basic email-safe defaults.
 */
function wrapEmailHtml(html: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark only">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: #1a1a1a;
    background: #ffffff;
    padding: 16px;
    -webkit-font-smoothing: antialiased;
    overflow-x: auto;
  }
  /* Preserve email images */
  img { max-width: 100% !important; height: auto; }
  /* Email-safe table handling */
  table { max-width: 100% !important; }
  td, th { word-break: break-word; }
  /* Links */
  a { color: #0066cc; text-decoration: underline; }
  /* Blockquotes */
  blockquote {
    margin: 8px 0;
    padding: 4px 12px;
    border-left: 3px solid #ccc;
    color: #555;
  }
  /* Code */
  pre { white-space: pre-wrap; word-break: break-word; }
  code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 13px; }
  /* Embedded content */
  video, embed, object { max-width: 100% !important; }

  @media (prefers-color-scheme: dark) {
    body {
      color: #e1e1e1;
      background: #1a1a1a;
    }
    a { color: #66b3ff; }
    blockquote { border-color: #444; color: #999; }
  }
</style>
</head>
<body>
${html}
</body>
</html>`;
}