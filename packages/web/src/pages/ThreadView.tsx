import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useEffect, useCallback, useMemo, useState } from "react";
import type { Missive, Thread } from "@theaiinc/missive-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, ImageOff, MailOpen, Reply } from "lucide-react";
import { useCompose } from "@/components/Compose";
import { Attachments } from "@/components/Attachments";
import { useMe, useSenders } from "@/hooks/useMe";
import { cn } from "@/lib/utils";
import { useAccountColors } from "@/hooks/useAccountColors";
import { TranslateBar, TranslatedBody, type Translation } from "@/components/Translate";
import { remoteImageUrls, rewriteImages, signImageUrls } from "@/lib/emailImages";

/** A failed load, with the HTTP status so a server error can be retried. */
class LoadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * A deploy restarts the API, which answers 5xx for a few minutes meanwhile:
 * keep trying for about a minute and a half before showing the error.
 * Other failures (gone, not yours) show at once.
 */
const retryServerErrors = (failures: number, error: unknown) =>
  failures < 8 && (!(error instanceof LoadError) || error.status >= 500);
const retryDelay = (failures: number) => Math.min(2000 * 2 ** failures, 15_000);

async function fetchThread(
  id: string
): Promise<{ thread: Thread; missives: Missive[] }> {
  const [threadRes, missivesRes] = await Promise.all([
    fetch(`/api/v1/thread/${id}`),
    fetch(`/api/v1/thread/${id}/missives`),
  ]);
  // An error answer is JSON too: used as the thread, it crashed the page.
  for (const res of [threadRes, missivesRes]) {
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new LoadError(body.message ?? body.error ?? `The conversation couldn't be loaded (${res.status}).`, res.status);
    }
  }
  const missives: unknown = await missivesRes.json();
  if (!Array.isArray(missives)) throw new Error("The conversation couldn't be loaded.");
  return {
    thread: await threadRes.json(),
    missives: missives as Missive[],
  };
}

export function ThreadView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { getColor } = useAccountColors();
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["thread", id],
    queryFn: () => fetchThread(id!),
    enabled: !!id,
    retry: retryServerErrors,
    retryDelay,
  });
  const queryClient = useQueryClient();
  const refreshCounts = () => {
    void queryClient.invalidateQueries({ queryKey: ["folders"] });
    void queryClient.invalidateQueries({ queryKey: ["missives"] });
  };
  // Opening a thread marks it read (here and in Gmail), so folder counts go down.
  const markedRead = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !data || markedRead.current === id) return;
    markedRead.current = id;
    if (!data.missives.some((m) => m.direction !== "outbound" && m.status === "unread")) return;
    fetch(`/api/v1/thread/${encodeURIComponent(id)}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    })
      .then(refreshCounts)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, data]);
  const markUnread = async () => {
    await fetch(`/api/v1/thread/${encodeURIComponent(id!)}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: false }),
    });
    refreshCounts();
    navigate(-1);
  };

  if (isLoading) {
    return (
      <div className="h-full flex flex-col">
        <div className="px-4 sm:px-8 py-4 border-b border-border bg-card space-y-3">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="flex-1 px-4 sm:px-8 py-4 space-y-4">
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

  if (error || !data) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-medium">This conversation couldn't be opened.</p>
        {error instanceof Error && <p className="text-xs text-muted-foreground max-w-md">{error.message}</p>}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            Back
          </Button>
          <Button size="sm" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? "Trying…" : "Try again"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Thread Header */}
      <div className="px-4 sm:px-8 py-4 border-b border-border bg-card">
        <div className="flex items-center gap-3 mb-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back
          </Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void markUnread()} title="Mark as unread and go back">
            <MailOpen className="w-4 h-4 mr-1" />
            Mark as unread
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
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Accounts:</span>
              {accounts.map((acct) => {
                const color = getColor(acct);
                return (
                  <span
                    key={acct}
                    className={cn(
                      "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight",
                      color.bg,
                      color.text,
                    )}
                  >
                    {acct}
                  </span>
                );
              })}
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
      <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-4 space-y-4">
        {data?.missives.map((missive, index) => (
          <EmailCard key={missive.id} missive={missive} />
        ))}
      </div>
    </div>
  );
}

function EmailCard({ missive }: { missive: Missive }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [translation, setTranslation] = useState<Translation | null>(null);

  // Remote images stay hidden (no tracking pixels) until shown or the sender is trusted;
  // shown ones load through Missive's proxy (lib/emailImages.ts).
  const remote = useMemo(() => (missive.bodyHtml ? remoteImageUrls(missive.bodyHtml) : []), [missive.bodyHtml]);
  const sender = missive.direction === "outbound" ? "" : missive.from.address;
  const { data: trust, refetch: refetchTrust } = useQuery<{ trusted: boolean }>({
    queryKey: ["image-trust", sender],
    queryFn: () => fetch(`/api/v1/images/trusted?address=${encodeURIComponent(sender)}`).then((r) => (r.ok ? r.json() : { trusted: false })),
    enabled: remote.length > 0 && !!sender,
    staleTime: 5 * 60_000,
  });
  const [showImages, setShowImages] = useState(false);
  // Your own messages show their images.
  const wantImages = remote.length > 0 && (showImages || trust?.trusted === true || missive.direction === "outbound");
  const { data: proxied, error: imageError } = useQuery<Record<string, string>>({
    queryKey: ["image-links", missive.id],
    queryFn: () => signImageUrls(remote),
    enabled: wantImages,
    staleTime: 60 * 60_000,
  });
  const bodyHtml = useMemo(
    () => (missive.bodyHtml ? rewriteImages(missive.bodyHtml, wantImages && proxied ? proxied : null) : ""),
    [missive.bodyHtml, wantImages, proxied],
  );
  const trustSender = async () => {
    await fetch("/api/v1/images/trusted", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: sender, trusted: true }),
    });
    setShowImages(true);
    void refetchTrust();
  };
  const { getColor } = useAccountColors();
  const compose = useCompose();
  const { data: me } = useMe();
  const senders = useSenders();
  // Reply from the address it came to when you may send as it (a hosted
  // mailbox, or a connected Gmail account, sent through Gmail); otherwise
  // from your own mailbox, or the first address you can send from.
  const mailbox =
    senders.find((s) => s.address === missive.accountEmail) ??
    senders.find((s) => s.kind === "mailbox") ??
    senders[0];
  const reply = async () => {
    const outbound = missive.direction === "outbound";
    const subject = missive.subject ?? "";
    // Mail relayed through a group (e.g. "X via info") names the person to answer in Reply-To.
    let to = outbound ? missive.to.map((t) => t.address).join(", ") : missive.from.address;
    if (!outbound) {
      try {
        const res = await fetch(`/api/v1/missive/${encodeURIComponent(missive.id)}/reply-recipients`);
        if (res.ok) to = ((await res.json()) as { to: { address: string }[] }).to.map((a) => a.address).join(", ") || to;
      } catch {}
    }
    compose({
      from: mailbox!.address,
      to,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      text: `\n\nOn ${new Date(missive.receivedAt).toLocaleString()}, ${missive.from.name ?? missive.from.address} wrote:\n${missive.body
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")}`,
      replyTo: missive.id,
      fromName: me?.name,
    });
  };

  const resizeIframe = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc) {
        const height = doc.documentElement.scrollHeight;
        if (height > 50) {
          iframe.style.minHeight = `${height}px`;
        }
      }
    } catch {}
  }, []);

  const onIframeLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (doc) openLinksInNewTabs(doc);
    resizeIframe();
  }, [resizeIframe]);

  useEffect(() => {
    if (!iframeRef.current || !missive.bodyHtml) return;
    // Initial resize after a small delay to let the srcdoc render
    const initial = setTimeout(resizeIframe, 100);
    return () => clearTimeout(initial);
  }, [bodyHtml, resizeIframe]);

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
            <Recipients missive={missive} />
            {missive.accountEmail && (
              <div className="mt-0.5">
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
          </div>
        </div>
        <div className="flex items-center gap-2">
          {mailbox && (
            <Button variant="outline" size="sm" onClick={() => void reply()}>
              <Reply className="w-3.5 h-3.5 mr-1.5" />
              Reply
            </Button>
          )}
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
      <TranslateBar missiveId={missive.id} translation={translation} onTranslation={setTranslation} />
      {remote.length > 0 && !wantImages && !translation && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-xs text-muted-foreground border-b border-border">
          <ImageOff className="w-3.5 h-3.5 shrink-0" />
          <span>Images are hidden, so the sender can't tell you opened this.</span>
          <button type="button" className="text-primary hover:underline" onClick={() => setShowImages(true)}>
            Show images
          </button>
          {sender && (
            <>
              <span aria-hidden>·</span>
              <button type="button" className="text-primary hover:underline" onClick={() => void trustSender()}>
                Always show from {sender}
              </button>
            </>
          )}
        </div>
      )}
      {imageError && wantImages && <p className="px-4 py-2 text-xs text-destructive border-b border-border">{(imageError as Error).message}</p>}
      <div className="p-0">
        {translation ? (
          <TranslatedBody translation={translation} />
        ) : missive.bodyHtml ? (
          <iframe
            ref={iframeRef}
            className="w-full border-0"
            style={{ minHeight: "200px" }}
            // No scripts. Links may open a new tab (openLinksInNewTabs), and
            // that tab is an ordinary page, not sandboxed like the email.
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            title="Email body"
            srcDoc={wrapEmailHtml(bodyHtml)}
            onLoad={onIframeLoad}
          />
        ) : (
          <div className="px-4 py-3 text-sm text-foreground whitespace-pre-wrap leading-relaxed">
            {missive.body}
          </div>
        )}
      </div>
      <Attachments files={missive.attachments} />
    </div>
  );
}

type Person = { name?: string; address: string };
const who = (p: Person) => (p.name ? `${p.name} <${p.address}>` : p.address);

/** To, Cc and (on your own sent mail) Bcc, one line each; long lists fold behind "+N more". */
function Recipients({ missive }: { missive: Missive }) {
  const [open, setOpen] = useState(false);
  const rows: [string, Person[]][] = [
    ["To", missive.to ?? []],
    ["Cc", missive.cc ?? []],
    // Only your own copy of a sent message knows its Bcc.
    ["Bcc", missive.direction === "outbound" ? missive.bcc ?? [] : []],
  ];
  const shown = rows.filter(([, list]) => list.length);
  if (!shown.length) return null;
  return (
    <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      {shown.map(([label, list]) => {
        const visible = open ? list : list.slice(0, 3);
        return (
          <p key={label} className="break-words">
            <span className="font-medium text-foreground/80">{label}:</span> {visible.map(who).join(", ")}
            {!open && list.length > 3 && (
              <button type="button" className="ml-1 text-primary hover:underline" onClick={() => setOpen(true)}>
                +{list.length - 3} more
              </button>
            )}
          </p>
        );
      })}
    </div>
  );
}

/**
 * Web links in an email open in a new tab, whatever target the email gave
 * them, and without window.opener or a referrer, so the site can't reach
 * Missive or see which message the link came from. mailto:, tel: and
 * in-message (#) links are left alone.
 */
function openLinksInNewTabs(doc: Document) {
  for (const base of Array.from(doc.querySelectorAll("base[target]"))) base.removeAttribute("target");
  for (const link of Array.from(doc.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>("a[href], area[href]"))) {
    // "#…" resolves against Missive's own URL in a srcdoc frame; it jumps within the message.
    if (link.getAttribute("href")?.trim().startsWith("#")) continue;
    if (/^https?:$/.test(link.protocol)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } else if (link.target) {
      link.removeAttribute("target");
    }
  }
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:">
<meta name="color-scheme" content="light">
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

  /* Always light, as Gmail and Apple Mail show HTML mail: emails are designed
     for a light page. A dark default here gave text the email left uncolored a
     light color, invisible on the white boxes most emails paint. */
</style>
</head>
<body>
${html}
</body>
</html>`;
}