import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSenders, useSignature } from "@/hooks/useMe";
import { Loader2, Paperclip, Sparkles, X } from "lucide-react";
import { formatSize } from "@/components/Attachments";
import { MessageEditor, editorText, textToHtml, useMessageEditor } from "@/components/MessageEditor";

/** What a new message starts with; a reply fills in the recipient, subject and quote. */
export type Draft = { id?: string; updatedAt?: string; from?: string; to?: string; cc?: string; bcc?: string; subject?: string; text?: string; html?: string; replyTo?: string; threadId?: string; fromName?: string; mailboxId?: string; attachments?: Array<{ filename: string; mimeType: string; content?: string }> };

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
  });
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [readReceipt, setReadReceipt] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [saveState, setSaveState] = useState<"saved" | "saving">("saved");
  const draftKey = `missive.draft.${draft.id ?? "new"}`;
  const latest = useRef<Draft>({ ...draft });

  useEffect(() => {
    try {
      const stored = localStorage.getItem(draftKey);
      if (!stored) return;
      const localDraft = JSON.parse(stored) as Draft;
      const serverTime = draft.updatedAt ? Date.parse(draft.updatedAt) : 0;
      const localTime = localDraft.updatedAt ? Date.parse(localDraft.updatedAt) : 0;
      if (localTime <= serverTime) return;
      setValues((current) => ({
        ...current,
        from: localDraft.from ?? current.from,
        to: localDraft.to ?? current.to,
        cc: localDraft.cc ?? current.cc,
        bcc: localDraft.bcc ?? current.bcc,
        subject: localDraft.subject ?? current.subject,
      }));
    } catch {
      // Ignore malformed or unavailable local storage.
    }
  }, [draft, draftKey]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // What follows what you write, as plain text: your signature for the From address, then a reply's quote.
  const quote = draft.replyTo ? (draft.text ?? "").replace(/^\\s+/, "") : "";
  const [tail, setTail] = useState(quote);
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

  const snapshot = useCallback((): Draft => ({
    ...draft,
    ...values,
    text: [written(), tail].filter(Boolean).join("\\n\\n"),
    html: (editor?.getHTML() ?? "") + textToHtml(tail),
    attachments: files.map((file) => ({ filename: file.name, mimeType: file.type || "application/octet-stream" })),
    updatedAt: new Date().toISOString(),
  }), [draft, values, files, tail]);

  const saveDraft = useCallback(async () => {
    const value = snapshot();
    latest.current = value;
    setSaveState("saving");
    try { localStorage.setItem(draftKey, JSON.stringify(value)); } catch { /* storage unavailable */ }
    try {
      const response = await fetch(`/api/v1/drafts${draft.id ? `/${encodeURIComponent(draft.id)}` : ""}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
        keepalive: true,
      });
      if (response.ok) {
        const saved = await response.json().catch(() => null);
        if (saved?.id && !draft.id) draft.id = saved.id;
      }
    } catch { /* localStorage remains the offline copy */ }
    setSaveState("saved");
  }, [draft, draftKey, snapshot]);

  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveDraft(), 1500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [values, tail, files, saveDraft]);

  useEffect(() => {
    const flush = () => { void saveDraft(); };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("beforeunload", flush); window.removeEventListener("pagehide", flush); };
  }, [saveDraft]);

  // What you write, formatted. A reply's draft.text is its quote, which goes below instead.
  const editor = useMessageEditor({ text: draft.replyTo ? "" : draft.text, autofocus: !!draft.to });
  const written = () => editorText(editor);

  const { data: signature } = useSignature(values.from);
  const tailFor = (sig: string) => [sig ? `-- \n${sig}` : "", quote].filter(Boolean).join("\n\n");
  // Swap the signature in when it loads or the From address changes, unless the tail was edited.
  const shownTail = useRef(quote);
  useEffect(() => {
    if (!signature) return;
    const next = tailFor(signature.text);
    setTail((t) => {
      if (t !== shownTail.current) return t;
      shownTail.current = next;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature?.text, signature?.address]);

  // "Write with AI": writes above the signature and quote.
  const [instructions, setInstructions] = useState("");
  const [drafting, setDrafting] = useState(false);
  const writeWithAi = async () => {
    setDrafting(true);
    setError(null);
    const above = written();
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
      // A reply keeps its "Re:" subject; a new email takes the suggested one when it has none.
      setValues((v) => ({ ...v, subject: draft.replyTo || v.subject.trim() ? v.subject : body.subject ?? v.subject }));
      editor?.chain().setContent(textToHtml(body.text), true).focus("end").run();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDrafting(false);
    }
  };

  const send = async () => {
    // The message as both parts: formatted (the server cleans it) and plain, for older servers and API callers.
    const formatted = editor && !editor.isEmpty ? editor.getHTML() : "";
    const text = [written().trim(), tail.trim()].filter(Boolean).join("\n\n");
    if (!text) {
      setError("Write a message.");
      editor?.commands.focus();
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...values,
          text,
          html: formatted + textToHtml(tail),
          replyTo: draft.replyTo,
          readReceipt,
          attachments: await Promise.all(files.map(encode)),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message ?? body.error ?? `Not sent (${res.status})`);
      toast.success(`Sent to ${values.to}`);
      if (draft.id) await fetch(`/api/v1/drafts/${encodeURIComponent(draft.id)}`, { method: "DELETE" }).catch(() => undefined);
      try { localStorage.removeItem(draftKey); } catch { /* storage unavailable */ }
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
                {drafting ? "Writing…" : written().trim() ? "Redraft" : "Draft"}
              </Button>
            </div>
          </div>
          <div className="grid gap-1">
            <span className={label}>Message</span>
            <MessageEditor editor={editor} />
          </div>
          {tail && (
            <label className="grid gap-1">
              <span className={label}>{quote ? "Signature and quoted message" : "Signature"}</span>
              <textarea
                value={tail}
                onChange={(e) => setTail(e.target.value)}
                rows={Math.min(8, tail.split("\n").length + 1)}
                className="rounded-md border border-input bg-muted/30 px-3 py-2 text-sm leading-relaxed text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          )}
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
            <span className="mr-auto self-center text-xs text-muted-foreground" aria-live="polite">{saveState === "saving" ? "Saving…" : "Saved"}</span>
            <Button
              type="button"
              variant="ghost"
              onClick={async () => {
                if (!window.confirm("Discard this draft?")) return;
                if (draft.id) await fetch(`/api/v1/drafts/${encodeURIComponent(draft.id)}`, { method: "DELETE" }).catch(() => undefined);
                try { localStorage.removeItem(draftKey); } catch { /* storage unavailable */ }
                onClose();
              }}
              disabled={sending}
            >
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
