import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle, CalendarDays, ChevronLeft, ChevronRight, Download, Link2, List, Loader2, MapPin, Plus, RefreshCw, Repeat, Trash2, Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// ── Types (backend: calendar/calendar.service.ts) ──

type Source = "local" | "url" | "gmail" | "outlook";
type Cal = {
  id: string; name: string; color: string; source: Source; sourceUrl: string | null; connectorId: string | null;
  visible: boolean; readOnly: boolean; lastSyncedAt: string | null; lastError: string | null;
};
type Account = { connectorId: string; provider: "gcal" | "outlook"; email: string; lastSyncedAt: string | null; lastError: string | null };
type Occ = {
  id: string; eventId: string; calendarId: string; occurrence: string; start: string; end: string; allDay: boolean; recurring: boolean;
  summary: string | null; description: string | null; location: string | null; organizer: string | null;
  attendees: { email: string; name?: string; status?: string }[]; url: string | null; status: string; tzid: string | null;
};

// ── API ──

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1/calendar/${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const d = data as { error?: string; message?: string }; throw new Error(d.error ?? d.message ?? `Request failed (${res.status})`); }
  return data as T;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ── Dates (local time) ──

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const fromYmd = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y!, m! - 1, d!); };
/** Monday-first grid of 6 weeks around the month. */
function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
/** The local days an occurrence covers (all-day ends are exclusive). */
function occDays(o: Occ): [Date, Date] {
  if (o.allDay) return [fromYmd(o.start), addDays(fromYmd(o.end), -1)];
  const s = new Date(o.start), e = new Date(o.end);
  const last = e > s && e.getHours() === 0 && e.getMinutes() === 0 ? addDays(startOfDay(e), -1) : startOfDay(e);
  return [startOfDay(s), last < startOfDay(s) ? startOfDay(s) : last];
}
const timeLabel = (o: Occ) => (o.allDay ? "All day" : new Date(o.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
const monthLabel = (d: Date) => d.toLocaleDateString([], { month: "long", year: "numeric" });
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const m = window.matchMedia("(max-width: 767px)");
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

// ── Page ──

export function Calendar() {
  const qc = useQueryClient();
  const narrow = useNarrow();
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [view, setView] = useState<"month" | "agenda">(narrow ? "agenda" : "month");
  const [selected, setSelected] = useState<Date>(startOfDay(new Date()));
  const [editing, setEditing] = useState<{ occ?: Occ; day?: Date } | null>(null);
  const [importing, setImporting] = useState(false);
  const [showCalendars, setShowCalendars] = useState(!narrow);
  useEffect(() => { if (narrow) setView("agenda"); }, [narrow]);

  const grid = useMemo(() => monthGrid(month), [month]);
  const from = grid[0]!, to = addDays(grid[41]!, 1);

  const calendars = useQuery({ queryKey: ["calendars"], queryFn: () => call<Cal[]>("calendars") });
  const accounts = useQuery({ queryKey: ["calendar-accounts"], queryFn: () => call<Account[]>("accounts") });
  const events = useQuery({
    queryKey: ["calendar-events", from.toISOString(), to.toISOString()],
    queryFn: () => call<Occ[]>(`events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`),
  });
  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["calendars"] });
    qc.invalidateQueries({ queryKey: ["calendar-accounts"] });
    qc.invalidateQueries({ queryKey: ["calendar-events"] });
  };

  const byId = new Map((calendars.data ?? []).map((c) => [c.id, c]));
  const colorOf = (o: Occ) => byId.get(o.calendarId)?.color ?? "#64748b";
  const ownCalendars = (calendars.data ?? []).filter((c) => !c.readOnly);

  const onDay = (day: Date) =>
    (events.data ?? []).filter((o) => { const [s, e] = occDays(o); return s <= day && day <= e; })
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || (a.start < b.start ? -1 : 1));

  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  const today = () => { const t = new Date(); setMonth(new Date(t.getFullYear(), t.getMonth(), 1)); setSelected(startOfDay(t)); };

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 md:px-8 py-3 border-b border-border bg-card flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground mr-2 min-w-40">{monthLabel(month)}</h2>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft className="w-4 h-4" /></Button>
          <Button variant="outline" size="sm" onClick={today}>Today</Button>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => shift(1)} aria-label="Next month"><ChevronRight className="w-4 h-4" /></Button>
        </div>
        <div className="flex items-center gap-1 ml-auto">
          {!narrow && (
            <div className="flex rounded-md border border-border overflow-hidden mr-1" role="group" aria-label="View">
              <button className={cn("px-2.5 py-1.5 text-xs flex items-center gap-1", view === "month" ? "bg-primary/10 text-primary" : "text-muted-foreground")} onClick={() => setView("month")}>
                <CalendarDays className="w-3.5 h-3.5" /> Month
              </button>
              <button className={cn("px-2.5 py-1.5 text-xs flex items-center gap-1", view === "agenda" ? "bg-primary/10 text-primary" : "text-muted-foreground")} onClick={() => setView("agenda")}>
                <List className="w-3.5 h-3.5" /> Agenda
              </button>
            </div>
          )}
          {narrow && <Button variant="outline" size="sm" onClick={() => setShowCalendars((s) => !s)}>Calendars</Button>}
          <Button variant="outline" size="sm" onClick={() => setImporting(true)}><Upload className="w-4 h-4 mr-1.5" />Import</Button>
          <Button size="sm" onClick={() => setEditing({ day: selected })} disabled={!ownCalendars.length && !calendars.isLoading}>
            <Plus className="w-4 h-4 mr-1.5" />Event
          </Button>
        </div>
      </div>

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {showCalendars && (
          <CalendarList calendars={calendars.data ?? []} accounts={accounts.data ?? []} onChanged={refreshAll} className={narrow ? "border-b max-h-[45vh]" : "w-64 border-r"} />
        )}

        <div className="flex-1 overflow-auto">
          {(events.isLoading || calendars.isLoading) && (
            <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" />Loading calendar…</div>
          )}
          {events.isError && (
            <div className="flex items-center justify-center py-16 text-muted-foreground"><AlertCircle className="w-5 h-5 mr-2" />{(events.error as Error).message}</div>
          )}
          {calendars.data && !calendars.data.length && (
            <EmptyState onNew={async () => { await call("calendars", json("POST", { name: "My calendar" })); refreshAll(); }} onImport={() => setImporting(true)} />
          )}
          {events.data && calendars.data?.length ? (
            view === "month" ? (
              <MonthView grid={grid} month={month} selected={selected} onDay={onDay} colorOf={colorOf}
                onSelect={(d) => setSelected(d)} onOpen={(o) => setEditing({ occ: o })} onNew={(d) => setEditing({ day: d })} />
            ) : (
              <AgendaView grid={grid} month={month} onDay={onDay} colorOf={colorOf} onOpen={(o) => setEditing({ occ: o })} />
            )
          ) : null}
        </div>
      </div>

      {editing && (
        <EventDialog
          occ={editing.occ} day={editing.day} calendars={calendars.data ?? []} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ["calendar-events"] }); }}
        />
      )}
      {importing && <ImportDialog calendars={ownCalendars} onClose={() => setImporting(false)} onDone={() => { setImporting(false); refreshAll(); }} />}
    </div>
  );
}

function EmptyState({ onNew, onImport }: { onNew: () => void; onImport: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center text-muted-foreground">
      <CalendarDays className="w-8 h-8 mb-3 opacity-40" />
      <p className="text-sm font-medium text-foreground">No calendars yet</p>
      <p className="text-xs mt-1 max-w-sm">Start your own, import an .ics file or link, or connect a Google or Microsoft account in Settings to see its calendars here.</p>
      <div className="flex gap-2 mt-4">
        <Button size="sm" onClick={onNew}><Plus className="w-4 h-4 mr-1.5" />New calendar</Button>
        <Button size="sm" variant="outline" onClick={onImport}><Upload className="w-4 h-4 mr-1.5" />Import</Button>
      </div>
    </div>
  );
}

// ── Month and agenda ──

function Chip({ o, color, onOpen }: { o: Occ; color: string; onOpen: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
      className={cn("w-full text-left truncate rounded px-1.5 py-0.5 text-[11px] leading-4", o.allDay ? "text-white" : "hover:bg-accent")}
      style={o.allDay ? { background: color } : undefined}
      title={o.summary ?? "(No title)"}
    >
      {!o.allDay && <span className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle" style={{ background: color }} />}
      {!o.allDay && <span className="text-muted-foreground mr-1">{timeLabel(o)}</span>}
      <span className={o.status === "tentative" ? "italic" : ""}>{o.summary ?? "(No title)"}</span>
    </button>
  );
}

function MonthView({ grid, month, selected, onDay, colorOf, onSelect, onOpen, onNew }: {
  grid: Date[]; month: Date; selected: Date; onDay: (d: Date) => Occ[]; colorOf: (o: Occ) => string;
  onSelect: (d: Date) => void; onOpen: (o: Occ) => void; onNew: (d: Date) => void;
}) {
  const now = new Date();
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <div className="h-full min-h-[560px] flex flex-col">
      <div className="grid grid-cols-7 border-b border-border text-xs text-muted-foreground">
        {days.map((d) => <div key={d} className="px-2 py-1.5">{d}</div>)}
      </div>
      <div className="flex-1 grid grid-cols-7 grid-rows-6">
        {grid.map((day) => {
          const list = onDay(day);
          const out = day.getMonth() !== month.getMonth();
          return (
            <div
              key={day.toISOString()}
              onClick={() => onSelect(day)}
              onDoubleClick={() => onNew(day)}
              className={cn("border-b border-r border-border p-1 min-h-0 overflow-hidden cursor-default", out && "bg-muted/30", sameDay(day, selected) && "ring-1 ring-inset ring-primary/60")}
            >
              <div className="flex justify-end">
                <span className={cn("text-xs w-6 h-6 flex items-center justify-center rounded-full", sameDay(day, now) ? "bg-primary text-primary-foreground font-semibold" : out ? "text-muted-foreground/60" : "text-foreground")}>
                  {day.getDate()}
                </span>
              </div>
              <div className="space-y-0.5">
                {list.slice(0, 3).map((o) => <Chip key={o.id} o={o} color={colorOf(o)} onOpen={() => onOpen(o)} />)}
                {list.length > 3 && <div className="text-[11px] text-muted-foreground px-1.5">+{list.length - 3} more</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgendaView({ grid, month, onDay, colorOf, onOpen }: { grid: Date[]; month: Date; onDay: (d: Date) => Occ[]; colorOf: (o: Occ) => string; onOpen: (o: Occ) => void }) {
  const days = grid.filter((d) => d.getMonth() === month.getMonth()).map((d) => ({ d, list: onDay(d) })).filter((x) => x.list.length);
  const now = startOfDay(new Date());
  const todayRef = useRef<HTMLDivElement>(null);
  useEffect(() => { todayRef.current?.scrollIntoView({ block: "start" }); }, [month]);
  if (!days.length) return <p className="text-sm text-muted-foreground px-6 py-10 text-center">Nothing this month.</p>;
  const firstUpcoming = days.find((x) => x.d >= now)?.d;
  return (
    <div className="max-w-3xl px-4 md:px-8 py-4 space-y-5">
      {days.map(({ d, list }) => (
        <div key={d.toISOString()} ref={firstUpcoming && sameDay(d, firstUpcoming) ? todayRef : undefined} className="flex gap-4">
          <div className="w-14 shrink-0 text-center">
            <div className="text-[11px] uppercase text-muted-foreground">{d.toLocaleDateString([], { weekday: "short" })}</div>
            <div className={cn("text-xl font-semibold", sameDay(d, now) && "text-primary")}>{d.getDate()}</div>
          </div>
          <div className="flex-1 min-w-0 space-y-1.5">
            {list.map((o) => (
              <button key={o.id} onClick={() => onOpen(o)} className="w-full text-left rounded-md border border-border px-3 py-2 hover:bg-accent flex gap-3">
                <span className="w-1 self-stretch rounded" style={{ background: colorOf(o) }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium truncate">{o.summary ?? "(No title)"}</span>
                  <span className="block text-xs text-muted-foreground truncate">
                    {o.allDay ? "All day" : `${timeLabel(o)} – ${new Date(o.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
                    {o.location && ` · ${o.location}`}
                  </span>
                </span>
                {o.recurring && <Repeat className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Calendars list ──

const SOURCE_LABEL: Record<Source, string> = { local: "My calendars", url: "Subscriptions", gmail: "Google", outlook: "Microsoft" };

function CalendarList({ calendars, accounts, onChanged, className }: { calendars: Cal[]; accounts: Account[]; onChanged: () => void; className?: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try { await fn(); if (done) toast.success(done); onChanged(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };
  const toggle = (c: Cal) => run(c.id, () => call(`calendars/${c.id}`, json("PATCH", { visible: !c.visible })));
  const reconnect = async (provider: string) => {
    const res = await fetch(`/api/v1/connector/${provider}/auth`);
    const data = await res.json().catch(() => ({}));
    if (data.url) window.location.href = data.url; else toast.error(data.message ?? "Couldn't start reconnecting");
  };
  const groups = (["local", "url"] as Source[]).map((s) => ({ key: s, title: SOURCE_LABEL[s], items: calendars.filter((c) => c.source === s) }));

  const Row = ({ c }: { c: Cal }) => (
    <div className="group flex items-center gap-2 px-2 py-1 rounded hover:bg-accent text-sm">
      <input type="checkbox" checked={c.visible} onChange={() => toggle(c)} className="w-3.5 h-3.5 rounded" style={{ accentColor: c.color }} aria-label={`Show ${c.name}`} />
      <span className="flex-1 min-w-0 truncate" title={c.lastError ?? c.name}>{c.name}</span>
      {c.lastError && <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0" aria-label={c.lastError} />}
      <span className="hidden group-hover:flex items-center gap-0.5">
        {c.source === "url" && (
          <button onClick={() => run(c.id, () => call(`calendars/${c.id}/refresh`, { method: "POST" }), "Refreshed")} title="Refresh" className="p-0.5 text-muted-foreground hover:text-foreground">
            <RefreshCw className={cn("w-3.5 h-3.5", busy === c.id && "animate-spin")} />
          </button>
        )}
        <a href={`/api/v1/calendar/calendars/${c.id}/export`} title="Export .ics" className="p-0.5 text-muted-foreground hover:text-foreground"><Download className="w-3.5 h-3.5" /></a>
        {c.source !== "gmail" && c.source !== "outlook" && (
          <button onClick={() => window.confirm(`Delete "${c.name}" and its events?`) && run(c.id, () => call(`calendars/${c.id}`, { method: "DELETE" }))} title="Delete" className="p-0.5 text-muted-foreground hover:text-destructive">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </span>
    </div>
  );

  return (
    <aside className={cn("shrink-0 bg-card overflow-y-auto p-3 space-y-4 border-border", className)}>
      {groups.map((g) => (
        <div key={g.key}>
          <div className="flex items-center justify-between px-2 mb-1">
            <span className="text-xs font-semibold uppercase text-muted-foreground">{g.title}</span>
            {g.key === "local" && (
              <button
                title="New calendar"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => { const name = window.prompt("Calendar name"); if (name?.trim()) run("new", () => call("calendars", json("POST", { name }))); }}
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {g.items.map((c) => <Row key={c.id} c={c} />)}
          {!g.items.length && <p className="px-2 text-xs text-muted-foreground">{g.key === "local" ? "None yet" : "Add one with Import → Subscribe"}</p>}
        </div>
      ))}
      <div>
        <div className="px-2 mb-1 text-xs font-semibold uppercase text-muted-foreground">Connected accounts</div>
        {!accounts.length && <p className="px-2 text-xs text-muted-foreground mb-1">See a Google or Microsoft account's calendars here (read-only).</p>}
        {accounts.map((a) => (
          <div key={a.connectorId} className="mb-2">
            <div className="flex items-center gap-2 px-2 py-1 text-xs">
              <span className="flex-1 min-w-0 truncate font-medium" title={a.email}>{a.email}</span>
              <button
                title="Sync now"
                onClick={() => run(a.connectorId, () => call(`accounts/${encodeURIComponent(a.connectorId)}/sync`, { method: "POST" }))}
                className="text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className={cn("w-3.5 h-3.5", busy === a.connectorId && "animate-spin")} />
              </button>
              {a.provider === "gcal" && (
                <button
                  title="Disconnect"
                  onClick={() => window.confirm(`Disconnect ${a.email}? Its calendars are removed from Missive.`) &&
                    run(a.connectorId, () => fetch("/api/v1/connector/gcal/disconnect", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: a.connectorId }) }))}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {a.lastError ? (
              <div className="mx-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                {a.lastError}
                <button className="block mt-1 underline font-medium" onClick={() => reconnect(a.provider)}>Reconnect {a.provider === "gcal" ? "Google" : "Microsoft"}</button>
              </div>
            ) : !a.lastSyncedAt ? (
              <p className="px-2 text-[11px] text-muted-foreground">Not synced yet — press sync.</p>
            ) : null}
            {calendars.filter((c) => c.connectorId === a.connectorId).map((c) => <Row key={c.id} c={c} />)}
          </div>
        ))}
        <div className="flex flex-col gap-1 px-2 mt-1">
          <button onClick={() => reconnect("gcal")} className="text-left text-xs text-primary hover:underline">+ Connect Google Calendar</button>
          <button onClick={() => reconnect("outlook")} className="text-left text-xs text-primary hover:underline">+ Connect Outlook</button>
        </div>
      </div>
    </aside>
  );
}

// ── Event dialog ──

const REPEATS = [
  { v: "", label: "Doesn't repeat" }, { v: "DAILY", label: "Daily" }, { v: "WEEKLY", label: "Weekly" }, { v: "MONTHLY", label: "Monthly" }, { v: "YEARLY", label: "Yearly" },
];
const selectClass = "flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm";

function EventDialog({ occ, day, calendars, onClose, onSaved }: { occ?: Occ; day?: Date; calendars: Cal[]; onClose: () => void; onSaved: () => void }) {
  const cal = occ ? calendars.find((c) => c.id === occ.calendarId) : undefined;
  const readOnly = !!cal?.readOnly;
  const own = calendars.filter((c) => !c.readOnly);
  const [editMode, setEditMode] = useState(!occ);

  const init = () => {
    if (occ) {
      const s = occ.allDay ? fromYmd(occ.start) : new Date(occ.start);
      const e = occ.allDay ? addDays(fromYmd(occ.end), -1) : new Date(occ.end);
      return { summary: occ.summary ?? "", calendarId: occ.calendarId, allDay: occ.allDay, date: ymd(s), time: hm(s), endDate: ymd(e), endTime: hm(e), location: occ.location ?? "", description: occ.description ?? "", repeat: "", until: "" };
    }
    const d = day ?? new Date();
    const next = new Date(); next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
    const t = sameDay(d, new Date()) ? hm(next) : "09:00";
    const [h, m] = t.split(":").map(Number);
    return { summary: "", calendarId: own[0]?.id ?? "", allDay: false, date: ymd(d), time: t, endDate: ymd(d), endTime: `${String((h! + 1) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`, location: "", description: "", repeat: "", until: "" };
  };
  const [f, setF] = useState(init);
  const set = <K extends keyof ReturnType<typeof init>>(k: K, v: ReturnType<typeof init>[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const toIso = (date: string, time: string) => { const [y, mo, d] = date.split("-").map(Number); const [h, mi] = time.split(":").map(Number); return new Date(y!, mo! - 1, d!, h, mi).toISOString(); };
      const body = {
        calendarId: f.calendarId, summary: f.summary, description: f.description, location: f.location, allDay: f.allDay, timeZone: TZ,
        start: f.allDay ? f.date : toIso(f.date, f.time), end: f.allDay ? f.endDate : toIso(f.endDate, f.endTime),
        repeat: f.repeat || null, repeatUntil: f.until || null,
      };
      return occ ? call(`events/${occ.eventId}`, json("PUT", body)) : call("events", json("POST", body));
    },
    onSuccess: () => { toast.success(occ ? "Event updated" : "Event added"); onSaved(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (only: boolean) => call(`events/${occ!.eventId}${only ? `?occurrence=${encodeURIComponent(occ!.occurrence)}` : ""}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("Deleted"); onSaved(); },
    onError: (e) => toast.error((e as Error).message),
  });

  const when = occ
    ? occ.allDay
      ? (() => { const [s, e] = [fromYmd(occ.start), addDays(fromYmd(occ.end), -1)]; return sameDay(s, e) ? s.toLocaleDateString([], { dateStyle: "full" }) : `${s.toLocaleDateString([], { dateStyle: "medium" })} – ${e.toLocaleDateString([], { dateStyle: "medium" })}`; })()
      : `${new Date(occ.start).toLocaleString([], { dateStyle: "full", timeStyle: "short" })} – ${new Date(occ.end).toLocaleTimeString([], { timeStyle: "short" })}`
    : "";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        {occ && !editMode ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-start gap-2">
                <span className="w-3 h-3 rounded-sm mt-1.5 shrink-0" style={{ background: cal?.color }} />
                <span>{occ.summary ?? "(No title)"}</span>
              </DialogTitle>
              <DialogDescription>{when}{occ.recurring && " · repeats"}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              {occ.location && <p className="flex gap-2"><MapPin className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />{occ.location}</p>}
              {occ.description && <p className="whitespace-pre-wrap text-muted-foreground break-words">{occ.description}</p>}
              {occ.organizer && <p className="text-xs text-muted-foreground">Organizer: {occ.organizer}</p>}
              {occ.attendees.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  <div className="font-medium text-foreground mb-1">{occ.attendees.length} guest{occ.attendees.length === 1 ? "" : "s"}</div>
                  {occ.attendees.slice(0, 20).map((a) => <div key={a.email} className="truncate">{a.name ?? a.email}{a.status && a.status !== "needs-action" ? ` · ${a.status}` : ""}</div>)}
                </div>
              )}
              {occ.url && <a href={occ.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline"><Link2 className="w-3 h-3" />Open in {cal?.source === "gmail" ? "Google Calendar" : cal?.source === "outlook" ? "Outlook" : "source"}</a>}
              <p className="text-xs text-muted-foreground">{cal?.name}{readOnly && " · synced, read-only"}</p>
            </div>
            {!readOnly && (
              <DialogFooter className="gap-2 sm:gap-2 flex-wrap">
                {occ.recurring ? (
                  <>
                    <Button variant="outline" size="sm" onClick={() => remove.mutate(true)} disabled={remove.isPending}>Delete this one</Button>
                    <Button variant="outline" size="sm" className="text-destructive" onClick={() => window.confirm("Delete every occurrence?") && remove.mutate(false)} disabled={remove.isPending}>Delete all</Button>
                  </>
                ) : (
                  <Button variant="outline" size="sm" className="text-destructive" onClick={() => remove.mutate(false)} disabled={remove.isPending}><Trash2 className="w-4 h-4 mr-1.5" />Delete</Button>
                )}
                <Button size="sm" onClick={() => setEditMode(true)}>Edit{occ.recurring ? " series" : ""}</Button>
              </DialogFooter>
            )}
          </>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-3">
            <DialogHeader>
              <DialogTitle>{occ ? "Edit event" : "New event"}</DialogTitle>
              <DialogDescription>Times are in your time zone ({TZ}).</DialogDescription>
            </DialogHeader>
            <Input autoFocus placeholder="Title" value={f.summary} onChange={(e) => set("summary", e.target.value)} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.allDay} onChange={(e) => set("allDay", e.target.checked)} />All day</label>
            <div className="grid grid-cols-2 gap-2">
              <Input type="date" aria-label="Start date" value={f.date} onChange={(e) => { set("date", e.target.value); if (e.target.value > f.endDate) set("endDate", e.target.value); }} required />
              {!f.allDay && <Input type="time" aria-label="Start time" value={f.time} onChange={(e) => set("time", e.target.value)} required />}
              <Input type="date" aria-label="End date" value={f.endDate} min={f.date} onChange={(e) => set("endDate", e.target.value)} required />
              {!f.allDay && <Input type="time" aria-label="End time" value={f.endTime} onChange={(e) => set("endTime", e.target.value)} required />}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select className={selectClass} aria-label="Repeat" value={f.repeat} onChange={(e) => set("repeat", e.target.value)}>
                {REPEATS.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
              </select>
              {f.repeat ? <Input type="date" aria-label="Repeat until" title="Until (optional)" value={f.until} min={f.date} onChange={(e) => set("until", e.target.value)} /> : <span />}
            </div>
            <select className={selectClass} aria-label="Calendar" value={f.calendarId} onChange={(e) => set("calendarId", e.target.value)} required>
              {own.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <Input placeholder="Location" value={f.location} onChange={(e) => set("location", e.target.value)} />
            <textarea placeholder="Notes" rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
            <DialogFooter className="gap-2 sm:gap-2">
              <Button type="button" variant="ghost" onClick={occ ? () => setEditMode(false) : onClose}>Cancel</Button>
              <Button type="submit" disabled={save.isPending || !f.calendarId}>{save.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Save</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Import dialog ──

function ImportDialog({ calendars, onClose, onDone }: { calendars: Cal[]; onClose: () => void; onDone: () => void }) {
  const [tab, setTab] = useState<"file" | "link">("file");
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState("new");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [dragging, setDragging] = useState(false);

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose an .ics file");
      if (file.size > 10 * 1024 * 1024) throw new Error("That file is larger than 10 MB");
      const q = new URLSearchParams(target === "new" ? { name: name || file.name.replace(/\.ics$/i, "") } : { calendarId: target });
      return call<{ imported: number; calendar: Cal }>(`import?${q}`, { method: "POST", headers: { "Content-Type": "text/calendar" }, body: await file.text() });
    },
    onSuccess: (r) => { toast.success(`Imported ${r.imported} event${r.imported === 1 ? "" : "s"} into ${r.calendar.name}`); onDone(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const subscribe = useMutation({
    mutationFn: () => call<{ imported: number; calendar: Cal }>("subscribe", json("POST", { url, name: name || undefined })),
    onSuccess: (r) => { toast.success(`Subscribed to ${r.calendar.name} (${r.imported} events)`); onDone(); },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a calendar</DialogTitle>
          <DialogDescription>From an .ics file (a one-time copy), or a calendar link that Missive keeps up to date.</DialogDescription>
        </DialogHeader>
        <div className="flex rounded-md border border-border overflow-hidden w-fit" role="tablist">
          {(["file", "link"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn("px-3 py-1.5 text-sm", tab === t ? "bg-primary/10 text-primary" : "text-muted-foreground")}>
              {t === "file" ? ".ics file" : "Subscribe to link"}
            </button>
          ))}
        </div>
        {tab === "file" ? (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); upload.mutate(); }}>
            <label
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}
              className={cn("flex flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed px-4 py-8 text-sm cursor-pointer", dragging ? "border-primary bg-primary/5" : "border-border")}
            >
              <Upload className="w-5 h-5 text-muted-foreground" />
              <span className="font-medium">{file ? file.name : "Drop an .ics file or choose one"}</span>
              <span className="text-xs text-muted-foreground">Exports from Google Calendar, Outlook, Apple Calendar…</span>
              <input type="file" accept=".ics,text/calendar" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <select className={selectClass} aria-label="Import into" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="new">Into a new calendar</option>
              {calendars.map((c) => <option key={c.id} value={c.id}>Into {c.name}</option>)}
            </select>
            {target === "new" && <Input placeholder="New calendar's name (optional)" value={name} onChange={(e) => setName(e.target.value)} />}
            <DialogFooter>
              <Button type="submit" disabled={!file || upload.isPending}>{upload.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Import</Button>
            </DialogFooter>
          </form>
        ) : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); subscribe.mutate(); }}>
            <Input placeholder="https://… or webcal://…" value={url} onChange={(e) => setUrl(e.target.value)} required />
            <Input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
            <p className="text-xs text-muted-foreground">Refreshed every hour. Use a calendar's "secret address in iCal format" or any public .ics link (holidays, sports, teams).</p>
            <DialogFooter>
              <Button type="submit" disabled={!url || subscribe.isPending}>{subscribe.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}Subscribe</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
