import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMe } from "@/hooks/useMe";

/** What a new message starts with; a reply fills in the recipient, subject and quote. */
export type Draft = { from?: string; to?: string; cc?: string; subject?: string; text?: string; replyTo?: string };

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

function ComposeDialog({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const mailboxes = me?.mailboxes ?? [];
  const [values, setValues] = useState({
    from: draft.from ?? mailboxes[0]?.address ?? "",
    to: draft.to ?? "",
    cc: draft.cc ?? "",
    subject: draft.subject ?? "",
    text: draft.text ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value }));

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, replyTo: draft.replyTo }),
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
      <DialogContent className="sm:max-w-2xl">
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
                  {m.displayName ? `${m.displayName} <${m.address}>` : m.address}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className={label}>To</span>
            <Input value={values.to} onChange={set("to")} placeholder="name@example.com, another@example.com" autoComplete="off" required autoFocus={!draft.to} />
          </label>
          <label className="grid gap-1">
            <span className={label}>Cc (optional)</span>
            <Input value={values.cc} onChange={set("cc")} autoComplete="off" />
          </label>
          <label className="grid gap-1">
            <span className={label}>Subject</span>
            <Input value={values.subject} onChange={set("subject")} required />
          </label>
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
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={sending}>
              Discard
            </Button>
            <Button type="submit" disabled={sending || mailboxes.length === 0}>
              {sending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
