/** A file attached to a draft: drafts keep what it was, not its bytes. */
export type DraftAttachment = { filename: string; mimeType: string; size?: number };

/** What a compose draft saves (PUT /api/v1/drafts/:id), and what reopening it restores. */
export type DraftPayload = {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  /** What you wrote, formatted (the editor's HTML; "" when empty). */
  html?: string;
  /** Everything as plain text: what you wrote, then the signature and quote. */
  text?: string;
  /** The signature and a reply's quote, as shown below the editor. */
  tail?: string;
  /** A reply's original quote. */
  quote?: string;
  replyTo?: string;
  threadId?: string;
  fromName?: string;
  mailboxId?: string;
  attachments?: DraftAttachment[];
};

export type DraftBody = { mailbox: string; payload: DraftPayload };

/** A draft as GET /api/v1/drafts lists it. */
export type StoredDraft = { id: string; mailbox: string; payload: DraftPayload; updatedAt: string; createdAt: string };

/**
 * What a new message starts with; a reply fills in the recipient, subject and
 * quote (`text`). A saved draft reopened (draftFromStored) also brings its id,
 * what it holds now (`saved`), its signature-and-quote `tail`, and the files
 * that were attached (`attachments`, names only: they're attached again to send).
 */
export type ComposeDraft = {
  id?: string;
  saved?: DraftBody;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text?: string;
  html?: string;
  tail?: string;
  replyTo?: string;
  threadId?: string;
  fromName?: string;
  mailboxId?: string;
  attachments?: DraftAttachment[];
};

/** Compose's starting point for a saved draft: everything it held, and its id so edits update it. */
export function draftFromStored(stored: StoredDraft): ComposeDraft {
  const p = stored.payload ?? {};
  return {
    id: stored.id,
    saved: { mailbox: stored.mailbox, payload: p },
    from: p.from ?? stored.mailbox,
    to: p.to,
    cc: p.cc,
    bcc: p.bcc,
    subject: p.subject,
    // A reply's `text` is its quote; a new message's comes back through `html`.
    text: p.replyTo ? p.quote ?? "" : undefined,
    html: p.html,
    tail: p.tail,
    replyTo: p.replyTo,
    threadId: p.threadId,
    fromName: p.fromName,
    mailboxId: p.mailboxId,
    attachments: p.attachments,
  };
}

/**
 * Nothing in it: no recipients, subject, message or attachment. The signature
 * and a reply's quote don't count; they're there before you write anything.
 * (The API's isEmptyDraftPayload, draft-content.ts, is the same rule.)
 */
export function draftIsEmpty(payload: DraftPayload): boolean {
  const blank = (value: unknown) => typeof value !== "string" || value.trim() === "";
  const body = (payload.html ?? "").replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "");
  return blank(payload.to) && blank(payload.cc) && blank(payload.bcc) && blank(payload.subject) && body === "" && !payload.attachments?.length;
}

/** A draft's title in a list: its subject, else the first line written. */
export function draftTitle(payload: DraftPayload): string {
  if (payload.subject?.trim()) return payload.subject.trim();
  const firstLine = (payload.html ?? "")
    .replace(/<\/(p|li|h\d)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return firstLine ?? "(no subject)";
}

/** JSON with keys sorted, so a payload the database handed back (keys reordered) compares equal. */
export function snapshotOf(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

export type SaveStatus = "idle" | "saving" | "saved" | "error";

/** Saves the draft with this id; resolves with what the API returned. */
export type SaveRequest = (id: string, body: DraftBody, options: { keepalive: boolean }) => Promise<{ id?: string }>;

type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };

/** After a failed save: wait 2 s, then 5 s, then every 15 s. */
export const RETRY_DELAYS = [2_000, 5_000, 15_000];

const newId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16));

/**
 * Saves one compose draft, so what you write is never lost and never doubled:
 *
 * - Only what changed: a payload the same as the last one saved isn't sent
 *   again, and a draft that doesn't exist yet isn't created while it's empty.
 * - One save at a time: while one is in flight, only the newest payload waits
 *   and goes next. The draft's id is chosen here up front (the API creates
 *   it with that id), so even the keepalive save on leaving the page can't
 *   make a second draft.
 * - A failed save is retried after 2 s, 5 s, then every 15 s, with whatever
 *   is newest by then, until it's saved or stop() is called (sent or discarded).
 */
export class DraftSaver {
  id: string;
  /** Whether the draft exists on the server: saved here at least once, or reopened. */
  exists: boolean;
  private savedSnapshot: string | null;
  private pending: { body: DraftBody; snapshot: string } | null = null;
  private running: Promise<void> | null = null;
  private retryHandle: unknown = null;
  private attempt = 0;
  private stopped = false;
  private readonly request: SaveRequest;
  private readonly onStatus: (status: SaveStatus) => void;
  private readonly delays: number[];
  private readonly timers: Timers;

  constructor(options: {
    request: SaveRequest;
    onStatus?: (status: SaveStatus) => void;
    /** A reopened draft: its id, and what it holds now (so reopening alone saves nothing). */
    id?: string;
    saved?: DraftBody;
    retryDelays?: number[];
    timers?: Timers;
  }) {
    this.request = options.request;
    this.onStatus = options.onStatus ?? (() => undefined);
    this.id = options.id ?? newId();
    this.exists = !!options.id;
    this.savedSnapshot = options.saved ? snapshotOf(options.saved) : null;
    this.delays = options.retryDelays ?? RETRY_DELAYS;
    this.timers = options.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  /** Whether this body still needs saving. */
  isUnsaved(body: DraftBody): boolean {
    if (!this.exists && draftIsEmpty(body.payload)) return false;
    return snapshotOf(body) !== this.savedSnapshot;
  }

  get retrying(): boolean {
    return this.retryHandle !== null;
  }

  /**
   * Saves body if it changed. Resolves once nothing newer is waiting (saved,
   * or failed and a retry scheduled). While a retry is scheduled, body waits
   * for it, unless `now` (closing the window): then it's tried straight away.
   */
  save(body: DraftBody, { now = false }: { now?: boolean } = {}): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.isUnsaved(body)) {
      // Back to what's saved: drop anything older that was waiting.
      this.pending = null;
      if (!this.running) {
        this.cancelRetry();
        if (this.exists) this.onStatus("saved");
      }
      return this.running ?? Promise.resolve();
    }
    this.pending = { body, snapshot: snapshotOf(body) };
    if (this.running) return this.running;
    if (this.retryHandle !== null && !now) return Promise.resolve();
    this.cancelRetry();
    return this.start(false);
  }

  /** Leaving the page: save the newest body with keepalive so it outlives the page. */
  flush(body: DraftBody): void {
    if (this.stopped || !this.isUnsaved(body)) return;
    this.pending = { body, snapshot: snapshotOf(body) };
    if (this.running) {
      // The save in flight has an older body; send the newest one now too (same id, so no second draft).
      void this.request(this.id, body, { keepalive: true }).then(
        () => this.markSaved(snapshotOf(body)),
        () => undefined,
      );
      return;
    }
    this.cancelRetry();
    void this.start(true);
  }

  /** Resolves when no save is in flight. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /** No more saves or retries: the draft was sent or discarded. */
  stop(): void {
    this.stopped = true;
    this.pending = null;
    this.cancelRetry();
  }

  private start(keepalive: boolean): Promise<void> {
    const run = this.drain(keepalive).finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private markSaved(snapshot: string) {
    this.savedSnapshot = snapshot;
    this.exists = true;
    if (this.pending?.snapshot === snapshot) this.pending = null;
  }

  private async drain(keepalive: boolean): Promise<void> {
    while (this.pending && !this.stopped) {
      const { body, snapshot } = this.pending;
      this.pending = null;
      if (snapshot === this.savedSnapshot) continue;
      this.onStatus("saving");
      try {
        const saved = await this.request(this.id, body, { keepalive });
        if (saved?.id) this.id = saved.id;
        this.markSaved(snapshot);
        this.attempt = 0;
      } catch {
        if (this.stopped) return;
        // Keep the newest: an edit made while this one failed wins over it.
        this.pending ??= { body, snapshot };
        this.onStatus("error");
        this.scheduleRetry();
        return;
      }
      keepalive = false;
    }
    if (!this.stopped) this.onStatus("saved");
  }

  private scheduleRetry() {
    const delay = this.delays[Math.min(this.attempt, this.delays.length - 1)]!;
    this.attempt += 1;
    this.retryHandle = this.timers.set(() => {
      this.retryHandle = null;
      if (this.pending && !this.stopped && !this.running) void this.start(false);
    }, delay);
  }

  private cancelRetry() {
    if (this.retryHandle !== null) this.timers.clear(this.retryHandle);
    this.retryHandle = null;
  }
}

/** The API call DraftSaver makes. */
export const putDraft: SaveRequest = async (id, body, { keepalive }) => {
  const json = snapshotOf(body);
  const res = await fetch(`/api/v1/drafts/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    // Browsers refuse keepalive bodies over 64 KB; a long draft goes as a plain request (it may still make it).
    keepalive: keepalive && json.length < 60_000,
    body: json,
  });
  if (!res.ok) throw new Error(`Draft save failed (${res.status})`);
  return res.json();
};
