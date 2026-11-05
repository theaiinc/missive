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
import { DraftSaver, draftFromStored, draftIsEmpty, putDraft, type ComposeDraft, type DraftAttachment, type DraftBody, type SaveStatus } from "@/lib/draftSaver";

/** What a new message starts with (see ComposeDraft); draftFromStored makes one from a saved draft. */
export type Draft = ComposeDraft;
export { draftFromStored };

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
  // An error shows below the fields; bring it into view when it appears.
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [error]);
  const [sending, setSending] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(draft.id ? "saved" : "idle");
  const [readReceipt, setReadReceipt] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  // Files a reopened draft had: drafts keep their names, not their contents.
  const [reattach, setReattach] = useState<DraftAttachment[]>(draft.attachments ?? []);
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
    touched.current = true;
    setFiles(next);
  };
  // Nothing is saved until you change something: opening Compose (or a draft) and closing it saves nothing.
  const touched = useRef(false);
  const touch = () => {
    touched.current = true;
  };
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => {
    touch();
    setValues((v) => ({ ...v, [key]: e.target.value }));
  };

  // What you write, formatted. A reply's draft.text is its quote, which goes below instead.
  const editor = useMessageEditor({ text: draft.replyTo ? "" : draft.text, autofocus: !!draft.to });
  const written = () => editorText(editor);

  useEffect(() => {
    if (editor && draft.html) editor.commands.setContent(draft.html, false);
  }, [editor, draft.html]);

  // Typing in the editor (or an AI draft landing in it) counts as a change.
  const [editorVersion, setEditorVersion] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => {
      touch();
      setEditorVersion((n) => n + 1);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor]);

  // What follows what you write, as plain text: your signature for the From address, then a reply's quote.
  const quote = draft.replyTo ? (draft.text ?? "").replace(/^\s+/, "") : "";
  const { data: signature } = useSignature(values.from);
  const tailFor = (sig: string) => [sig ? `-- \n${sig}` : "", quote].filter(Boolean).join("\n\n");
  const [tail, setTail] = useState(draft.tail ?? quote);
  // Swap the signature in when it loads or the From address changes, unless the tail was edited.
  // A reopened draft keeps the tail it was saved with.
  const shownTail = useRef<string | null>(draft.tail !== undefined ? null : quote);
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

  // The draft as saved: everything needed to reopen it as it is now.
  const body = (): DraftBody => ({
    mailbox: values.from,
    payload: {
      ...values,
      html: editor && !editor.isEmpty ? editor.getHTML() : "",
      text: [written().trim(), tail.trim()].filter(Boolean).join("\n\n"),
      tail,
      quote: quote || undefined,
      replyTo: draft.replyTo,
      threadId: draft.threadId,
      fromName: draft.fromName,
      mailboxId: draft.mailboxId,
      attachments: [...reattach, ...files.map((file) => ({ filename: file.name, mimeType: file.type, size: file.size }))],
    },
  });
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const sendingRef = useRef(false);

  // One saver per window: change detection, one save at a time, retries (lib/draftSaver.ts).
  // It outlives the window, so a save that failed keeps retrying after you close it.
  const [saver] = useState(() => new DraftSaver({ id: draft.id, saved: draft.saved, request: putDraft, onStatus: setSaveStatus }));
  const canSave = () => touched.current && !sendingRef.current && !!values.from;
  const saveDraft = (options?: { now?: boolean }) => (canSave() ? saver.save(bodyRef.current(), options) : Promise.resolve());

  useEffect(() => {
    if (!touched.current) return;
    const timer = window.setTimeout(() => void saveDraft(), 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, tail, files, reattach, editorVersion]);

  // Leaving or hiding the page: save now, with keepalive so it gets there even as the page goes.
  useEffect(() => {
    const flush = () => {
      if (canSave()) saver.flush(bodyRef.current());
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    // Still unsaved (offline, or the save is still on its way): ask before the page goes.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (canSave() && (saver.isUnsaved(bodyRef.current()) || saver.retrying)) e.preventDefault();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saver]);

  const refreshDrafts = () => void queryClient.invalidateQueries({ queryKey: ["drafts"] });

  // Closing keeps the draft (find it under Drafts).
  const close = async () => {
    if (sending) return;
    await saveDraft({ now: true });
    if (canSave() && (saver.retrying || saver.isUnsaved(bodyRef.current()))) {
      toast.warning("Your draft isn't saved yet. Missive keeps trying while this tab is open.");
    }
    refreshDrafts();
    onClose();
  };

  // Discarding deletes the draft, after asking if there's anything in it (a fresh reply's prefilled fields don't count).
  const discard = async () => {
    if (sending) return;
    const current = bodyRef.current();
    if ((touched.current || saver.exists) && !draftIsEmpty(current.payload) && !window.confirm("Discard this draft? What you wrote will be deleted.")) return;
    saver.stop();
    await saver.settled();
    if (saver.exists) {
      const res = await fetch(`/api/v1/drafts/${encodeURIComponent(saver.id)}`, { method: "DELETE" }).catch(() => null);
      if (!res || (!res.ok && res.status !== 403)) toast.error("Couldn't delete the draft. It's still under Drafts.");
    }
    refreshDrafts();
    onClose();
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
    if (reattach.length) {
      setError(`Attach ${reattach.map((a) => a.filename).join(", ")} again, or remove ${reattach.length === 1 ? "it" : "them"}: drafts keep a file's name, not the file.`);
      return;
    }
    setSending(true);
    sendingRef.current = true;
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
      // Sent: the draft goes. Wait for a save on its way first, or it would bring the draft back.
      saver.stop();
      await saver.settled();
      if (saver.exists) await fetch(`/api/v1/drafts/${encodeURIComponent(saver.id)}`, { method: "DELETE" }).catch(() => undefined);
      refreshDrafts();
      toast.success(`Sent to ${values.to}`);
      onClose();
      // Refresh in the background; some queries (digest, organizer) are slow.
      void queryClient.invalidateQueries();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  };

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && void close()}>
      <DialogContent
        className="sm:max-w-2xl max-h-[90dvh] overflow-hidden flex flex-col"
        // Files dropped anywhere on the window are attached.
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
        onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); addFiles(e.dataTransfer.files); }}
      >
        <DialogHeader className="sticky top-0 z-10 bg-background">
          {/* pr-6 keeps the status clear of the dialog's close button. */}
          <div className="flex items-center justify-between gap-3 pr-6">
            <DialogTitle>{draft.replyTo ? "Reply" : "New message"}</DialogTitle>
            <span className="text-xs text-muted-foreground" role="status" aria-label="Draft save status">
              {saveStatus === "saving" ? "Saving…" : saveStatus === "error" ? "Couldn't save, retrying" : saveStatus === "saved" ? "Saved to Drafts" : ""}
            </span>
          </div>
          {mailboxes.length === 0 && (
            <DialogDescription>You don't have a mailbox to send from yet. Ask an admin to create one for you.</DialogDescription>
          )}
        </DialogHeader>
        <form
          className="grid min-h-0 gap-3 overflow-y-auto pr-1"
          onBlur={() => void saveDraft()}
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
                onChange={(e) => { touch(); setTail(e.target.value); }}
                rows={Math.min(8, tail.split("\n").length + 1)}
                className="rounded-md border border-input bg-muted/30 px-3 py-2 text-sm leading-relaxed text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          )}
          <div className="grid gap-2">
            {reattach.length > 0 && (
              <div className="grid gap-1.5">
                <p className="text-xs text-muted-foreground">Attached before; attach again to send (drafts keep a file's name, not the file):</p>
                <ul className="flex flex-wrap gap-2" aria-label="Files to attach again">
                  {reattach.map((a, i) => (
                    <li key={`${a.filename}-${i}`} className="flex items-center gap-1.5 rounded-md border border-dashed border-border pl-2 pr-1 py-1 text-xs text-muted-foreground max-w-full">
                      <Paperclip className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate max-w-[14rem]">{a.filename}</span>
                      {a.size !== undefined && <span className="shrink-0">{formatSize(a.size)}</span>}
                      <button type="button" onClick={() => { touch(); setReattach(reattach.filter((_, j) => j !== i)); }} className="p-0.5 hover:text-foreground" aria-label={`Remove ${a.filename}`}>
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label="Attachments">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center gap-1.5 rounded-md border border-border bg-muted/30 pl-2 pr-1 py-1 text-xs max-w-full">
                    <Paperclip className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate max-w-[14rem]">{f.name}</span>
                    <span className="text-muted-foreground shrink-0">{formatSize(f.size)}</span>
                    <button type="button" onClick={() => { touch(); setFiles(files.filter((_, j) => j !== i)); }} className="p-0.5 text-muted-foreground hover:text-foreground" aria-label={`Remove ${f.name}`}>
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
            <p ref={errorRef} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="sticky bottom-0 z-10 bg-background pt-2">
            <Button type="button" variant="ghost" onClick={() => void discard()} disabled={sending}>
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
