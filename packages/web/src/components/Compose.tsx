import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSenders, useSignature } from "@/hooks/useMe";
import { Loader2, Paperclip, Sparkles, X } from "lucide-react";
import { formatSize } from "@/components/Attachments";

/** What a new message starts with; a reply fills in the recipient, subject and quote. */
export type Draft = { from?: string; to?: string; cc?: string; bcc?: string; subject?: string; text?: string; replyTo?: string; fromName?: string };

const ComposeContext = createContext<(draft?: Draft) => void>(() => undefined);

/** Opens the compose window from anywhere under ComposeProvider. */
export const useCompose = () => useContext(ComposeContext);

export function ComposeProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const open = useCallback((d: Draft = {}) => setDraft(d), []);
  return (
    <ComposeContext.Provider value={open}>
      {children}
      {draft && <ComposeDialog key={JSON.stringify(draft)} draft={draft} onClose={() => setDraft(null)} />}
    </ComposeContext.Provider>
  );
}

const label = "text-xs font-medium text-muted-foreground";

/** Gmail and Cloudflare take 25 MB per message; this leaves room for the text (the API checks too). */
const MAX_FILES_BYTES = 24 * 1024 * 1024;

/** A file as the send API takes it: its content base64. */
const encode = (file: File) =>
  new Promise<{ filename: string; mimeType: string; content: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ filename: file.name, mimeType: file.type || "application/octet-stream", content: String(reader.result).split(",", 2)[1] ?? "" });
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });

function ComposeDialog({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const queryClient = useQueryClient();
  const mailboxes = useSenders();
  const [values, setValues] = useState({
    from: draft.from ?? mailboxes[0]?.address ?? "",
    to: draft.to ?? "",
    cc: draft.cc ?? "",
    bcc: draft.bcc ?? "",
    subject: draft.subject ?? "",
    text: draft.text ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [readReceipt, setReadReceipt] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const filesBytes = files.reduce((n, f) => n + f.size, 0);
  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    const next = [...files, ...Array.from(list)];
    if (next.reduce((n, f) => n + f.size, 0) > MAX_FILES_BYTES) {
      setError("Attachments can be 24 MB in all.");
      return;
    }
    setError(null);
    setFiles(next);
  };
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value }));

  // What follows what you write: your signature for the From address, then a reply's quote.
  const quote = draft.replyTo ? (draft.text ?? "").replace(/^\s+/, "") : "";
  const { data: signature } = useSignature(values.from);
  const tailFor = (sig: string) => (sig ? `\n\n-- \n${sig}` : "") + (quote ? `\n\n${quote}` : "");
  const tail = tailFor(signature?.text ?? "");
  // Swap the signature in when it loads or the From address changes, unless the tail was edited.
  const shownTail = useRef(quote ? `\n\n${quote}` : "");
  useEffect(() => {
    if (!signature) return;
    const next = tailFor(signature.text);
    setValues((v) => {
      const prev = shownTail.current;
      if (!v.text.endsWith(prev)) return v;
      shownTail.current = next;
      return { ...v, text: v.text.slice(0, v.text.length - prev.length) + next };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature?.text, signature?.address]);
  const written = (text: string) => (text.endsWith(shownTail.current) ? text.slice(0, text.length - shownTail.current.length) : text);

  // "Write with AI": writes above the signature and quote.
  const [instructions, setInstructions] = useState("");
  const [drafting, setDrafting] = useState(false);
  const writeWithAi = async () => {
    setDrafting(true);
    setError(null);
    const above = written(values.text);
    try {
      const res = await fetch("/api/v1/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instructions,
          replyTo: draft.replyTo,
          to: values.to,
          subject: values.subject,
          current: above.trim() ? above : undefined,
          fromName: draft.fromName ?? mailboxes.find((m) => m.address === values.from)?.displayName,
          hasSignature: !!signature?.text,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Couldn't write a draft (${res.status})`);
      setValues((v) => ({
        ...v,
        // A reply keeps its "Re:" subject; a new email takes the suggested one when it has none.
        subject: draft.replyTo || v.subject.trim() ? v.subject : body.subject ?? v.subject,
        text: body.text + (v.text.endsWith(shownTail.current) ? shownTail.current : tail),
      }));
      shownTail.current = shownTail.current && values.text.endsWith(shownTail.current) ? shownTail.current : tail;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDrafting(false);
    }
  };

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, replyTo: draft.replyTo, readReceipt, attachments: await Promise.all(files.map(encode)) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message ?? body.error ?? `Not sent (${res.status})`);
      toast.success(`Sent to ${values.to}`);
      onClose();
      // Refresh in the background; some queries (digest, organizer) are slow.
      void queryClient.invalidateQueries();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && !sending && onClose()}>
      <DialogContent
        className="sm:max-w-2xl"
        // Files dropped anywhere on the window are attached.
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
        onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); addFiles(e.dataTransfer.files); }}
      >
        <DialogHeader>
          <DialogTitle>{draft.replyTo ? "Reply" : "New message"}</DialogTitle>
          {mailboxes.length === 0 && (
            <DialogDescription>You don't have a mailbox to send from yet. Ask an admin to create one for you.</DialogDescription>
          )}
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <label className="grid gap-1">
            <span className={label}>From</span>
            <select
              value={values.from}
              onChange={set("from")}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              required
            >
              {mailboxes.map((m) => (
                <option key={m.address} value={m.address}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className={label}>To</span>
            <Input value={values.to} onChange={set("to")} placeholder="name@example.com, another@example.com" autoComplete="off" required autoFocus={!draft.to} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1">
              <span className={label}>Cc (optional)</span>
              <Input value={values.cc} onChange={set("cc")} autoComplete="off" />
            </label>
            <label className="grid gap-1">
              <span className={label}>Bcc (optional, hidden from others)</span>
              <Input value={values.bcc} onChange={set("bcc")} autoComplete="off" />
            </label>
          </div>
          <label className="grid gap-1">
            <span className={label}>Subject</span>
            <Input value={values.subject} onChange={set("subject")} required />
          </label>
          <div className="grid gap-1">
            <span className={label}>Write with AI</span>
            <div className="flex gap-2">
              <Input
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (!drafting && (draft.replyTo || instructions.trim())) void writeWithAi();
                  }
                }}
                placeholder={draft.replyTo ? "What to say, e.g. \"accept, suggest Thursday 3pm\" (optional)" : "What it's about, e.g. \"ask An for the Q3 invoice, in Vietnamese\""}
                autoComplete="off"
                disabled={drafting}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => void writeWithAi()}
                disabled={drafting || sending || (!draft.replyTo && !instructions.trim())}
              >
                {drafting ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
                {drafting ? "Writing…" : written(values.text).trim() ? "Redraft" : "Draft"}
              </Button>
            </div>
          </div>
          <label className="grid gap-1">
            <span className={label}>Message</span>
            <textarea
              value={values.text}
              onChange={set("text")}
              rows={12}
              required
              autoFocus={!!draft.to}
              onFocus={(e) => draft.replyTo && e.currentTarget.setSelectionRange(0, 0)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <div className="grid gap-2">
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label="Attachments">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center gap-1.5 rounded-md border border-border bg-muted/30 pl-2 pr-1 py-1 text-xs max-w-full">
                    <Paperclip className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate max-w-[14rem]">{f.name}</span>
                    <span className="text-muted-foreground shrink-0">{formatSize(f.size)}</span>
                    <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} className="p-0.5 text-muted-foreground hover:text-foreground" aria-label={`Remove ${f.name}`}>
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={sending}>
                <Paperclip className="w-3.5 h-3.5 mr-1.5" />
                Attach files
              </Button>
              {files.length > 0 && <span className="text-xs text-muted-foreground">{formatSize(filesBytes)} of 24 MB</span>}
              <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground" title="Asks their mail app to tell you when it's opened. Many apps ignore this, or ask the reader first.">
            <input type="checkbox" checked={readReceipt} onChange={(e) => setReadReceipt(e.target.checked)} className="h-3.5 w-3.5" />
            Request a read receipt
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={sending}>
              Discard
            </Button>
            <Button type="submit" disabled={sending || drafting || mailboxes.length === 0}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
