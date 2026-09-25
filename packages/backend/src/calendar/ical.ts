import ICAL from "ical.js";
import { RRule, rrulestr } from "rrule";

/**
 * iCalendar (.ics) in and out, and repeating events expanded into the
 * occurrences a view needs. Pure functions; calendar.service.ts stores them.
 *
 * Times are kept the way the calendar wrote them: a wall-clock time
 * ("2026-10-05T09:00:00") plus an IANA time zone. Repeats are worked out on
 * wall-clock time and only then turned into instants, so a weekly 9:00
 * meeting stays at 9:00 across daylight-saving changes. A zone that isn't an
 * IANA name (Outlook's "SE Asia Standard Time") is converted to UTC with the
 * file's own VTIMEZONE instead.
 */

export type Attendee = { email: string; name?: string; status?: string };

export type ParsedEvent = {
  uid: string;
  recurrenceId: string; // "" unless this overrides one occurrence of a series
  summary: string | null;
  description: string | null;
  location: string | null;
  organizer: string | null;
  attendees: Attendee[];
  url: string | null;
  startWall: string; // YYYY-MM-DDTHH:mm:ss
  endWall: string;
  tzid: string | null; // IANA; null = UTC
  allDay: boolean;
  rrule: string | null;
  exdates: string[]; // wall times, same zone as start
  status: string; // confirmed | tentative | cancelled
  sequence: number;
};

export type StoredEvent = ParsedEvent & { id: string; calendarId: string };

export type Occurrence = {
  id: string; // event id + occurrence wall time
  eventId: string;
  calendarId: string;
  uid: string;
  occurrence: string; // the occurrence's wall start (identifies it within a series)
  start: string; // ISO instant, or YYYY-MM-DD for all-day
  end: string;
  allDay: boolean;
  recurring: boolean;
  summary: string | null;
  description: string | null;
  location: string | null;
  organizer: string | null;
  attendees: Attendee[];
  url: string | null;
  status: string;
  tzid: string | null;
};

const DAY = 86_400_000;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

// ── Time zones ──

const ianaCache = new Map<string, boolean>();
export function isIana(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  if (!ianaCache.has(tz)) {
    let ok = true;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      ok = false;
    }
    ianaCache.set(tz, ok);
  }
  return ianaCache.get(tz)!;
}

/** The IANA zone a TZID names, if any: "Europe/Berlin", or "/mozilla.org/…/Europe/Berlin". */
export function ianaFrom(tzid: string | null | undefined): string | null {
  if (!tzid) return null;
  if (isIana(tzid)) return tzid;
  const parts = String(tzid).split("/").filter(Boolean);
  for (let i = Math.max(0, parts.length - 3); i < parts.length; i++) {
    const tail = parts.slice(i).join("/");
    if (isIana(tail)) return tail;
  }
  return null;
}

/** Milliseconds `tz` is ahead of UTC at instant `ms`. */
function offsetAt(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(ms / 1000) * 1000;
}

/** Wall-clock time as UTC fields (a "floating" Date). */
export const wallMs = (wall: string) => Date.parse(`${wall}Z`);
export const msWall = (ms: number) => new Date(ms).toISOString().slice(0, 19);

/** The instant a wall-clock time in `tz` happens (UTC when tz is null). In a DST gap, the time an hour on. */
export function wallToInstant(wall: string, tz: string | null): number {
  const guess = wallMs(wall);
  if (!tz) return guess;
  const first = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(first, tz);
  return second;
}

export function instantToWall(ms: number, tz: string | null): string {
  return msWall(tz ? ms + offsetAt(ms, tz) : ms);
}

// ── Parsing ──

function timeWall(t: ICAL.Time): string {
  return `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
}

/** Wall time and IANA zone for a DATE/DATE-TIME property value. */
function wallAndZone(t: ICAL.Time, tzid: string | null): { wall: string; tz: string | null } {
  if (t.isDate) return { wall: timeWall(t), tz: null };
  const named = (t as unknown as { timezone?: string }).timezone ?? null;
  const utc = t.zone === ICAL.Timezone.utcTimezone || named === "Z";
  if (utc) return { wall: timeWall(t), tz: null };
  const iana = ianaFrom(tzid ?? named ?? t.zone?.tzid);
  if (iana) return { wall: timeWall(t), tz: iana };
  // Unknown zone: trust the file's VTIMEZONE (registered before parsing) and use UTC.
  if (t.zone && t.zone !== ICAL.Timezone.localTimezone) return { wall: msWall(t.toUnixTime() * 1000), tz: null };
  return { wall: timeWall(t), tz: null }; // floating: treat as UTC
}

/** A value from one zone, as wall time in another (for EXDATE / RECURRENCE-ID written differently from DTSTART). */
function inZone(t: ICAL.Time, tzid: string | null, target: string | null, allDay: boolean): string {
  if (allDay) return `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}T00:00:00`;
  const v = wallAndZone(t, tzid);
  return v.tz === target ? v.wall : instantToWall(wallToInstant(v.wall, v.tz), target);
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const mailto = (v: unknown) => (typeof v === "string" ? v.replace(/^mailto:/i, "").trim() || null : null);

/** Every event in an .ics file (VEVENTs; to-dos and journal entries are skipped). */
export function parseIcs(ics: string): { name: string | null; events: ParsedEvent[] } {
  const root = new ICAL.Component(ICAL.parse(ics));
  const calendars = root.name === "vcalendar" ? [root] : root.getAllSubcomponents("vcalendar");
  if (!calendars.length) throw new Error("Not an iCalendar file (no VCALENDAR)");
  const events: ParsedEvent[] = [];
  let name: string | null = null;
  for (const cal of calendars) {
    name ??= text(cal.getFirstPropertyValue("x-wr-calname"));
    for (const vtz of cal.getAllSubcomponents("vtimezone")) {
      const tz = new ICAL.Timezone(vtz);
      if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz, tz.tzid);
    }
    for (const ve of cal.getAllSubcomponents("vevent")) {
      const startProp = ve.getFirstProperty("dtstart");
      if (!startProp) continue;
      const start = startProp.getFirstValue() as ICAL.Time;
      const startTzid = (startProp.getParameter("tzid") as string | undefined) ?? null;
      const allDay = start.isDate;
      const { wall: startWall, tz } = wallAndZone(start, startTzid);

      let endWall: string;
      const endProp = ve.getFirstProperty("dtend");
      const duration = ve.getFirstPropertyValue("duration") as ICAL.Duration | null;
      if (endProp) {
        const end = endProp.getFirstValue() as ICAL.Time;
        endWall = inZone(end, (endProp.getParameter("tzid") as string | undefined) ?? null, tz, allDay);
      } else if (duration) {
        endWall = msWall(wallMs(startWall) + duration.toSeconds() * 1000);
      } else {
        endWall = msWall(wallMs(startWall) + (allDay ? DAY : 0));
      }
      if (wallMs(endWall) < wallMs(startWall)) endWall = startWall;

      const exdates: string[] = [];
      for (const p of ve.getAllProperties("exdate")) {
        const tzid = (p.getParameter("tzid") as string | undefined) ?? null;
        for (const v of p.getValues() as ICAL.Time[]) exdates.push(inZone(v, tzid, tz, allDay));
      }
      const ridProp = ve.getFirstProperty("recurrence-id");
      const recurrenceId = ridProp
        ? inZone(ridProp.getFirstValue() as ICAL.Time, (ridProp.getParameter("tzid") as string | undefined) ?? null, tz, allDay)
        : "";
      const rrule = ve.getFirstPropertyValue("rrule") as ICAL.Recur | null;

      const org = ve.getFirstProperty("organizer");
      const attendees: Attendee[] = ve.getAllProperties("attendee").flatMap((p) => {
        const email = mailto(p.getFirstValue());
        if (!email) return [];
        const a: Attendee = { email };
        const cn = p.getParameter("cn");
        if (typeof cn === "string" && cn) a.name = cn;
        const st = p.getParameter("partstat");
        if (typeof st === "string") a.status = st.toLowerCase();
        return [a];
      });

      events.push({
        uid: text(ve.getFirstPropertyValue("uid")) ?? `${startWall}-${Math.random().toString(36).slice(2)}@missive`,
        recurrenceId,
        summary: text(ve.getFirstPropertyValue("summary")),
        description: text(ve.getFirstPropertyValue("description")),
        location: text(ve.getFirstPropertyValue("location")),
        organizer: org ? mailto(org.getFirstValue()) : null,
        attendees,
        url: text(ve.getFirstPropertyValue("url")),
        startWall,
        endWall,
        tzid: allDay ? null : tz,
        allDay,
        rrule: rrule && !recurrenceId ? rrule.toString() : null,
        exdates,
        status: (text(ve.getFirstPropertyValue("status")) ?? "confirmed").toLowerCase(),
        sequence: Number(ve.getFirstPropertyValue("sequence")) || 0,
      });
    }
  }
  return { name, events };
}

// ── Repeats ──

function rule(e: Pick<ParsedEvent, "rrule" | "startWall">): RRule {
  // Floating: DTSTART as UTC fields, so repeats step in wall-clock time.
  return rrulestr(`RRULE:${e.rrule}`, { dtstart: new Date(wallMs(e.startWall)) }) as RRule;
}

const MAX_OCCURRENCES = 5000;

/** First occurrence start and, for a series that ends, the last occurrence's end (instants). Null until = forever. */
export function span(e: ParsedEvent): { startsAt: number; untilAt: number | null } {
  const tz = e.allDay ? null : e.tzid;
  const startsAt = wallToInstant(e.startWall, tz);
  const length = wallMs(e.endWall) - wallMs(e.startWall);
  if (!e.rrule) return { startsAt, untilAt: wallToInstant(e.endWall, tz) };
  const r = rule(e);
  if (!r.options.until && !r.options.count) return { startsAt, untilAt: null };
  const all = r.all((_, i) => i < MAX_OCCURRENCES);
  const last = all.length ? all[all.length - 1]!.getTime() : wallMs(e.startWall);
  return { startsAt, untilAt: wallToInstant(msWall(last + length), tz) };
}

/**
 * The occurrences of `events` overlapping [from, to). A series skips its
 * EXDATEs and the occurrences an override replaces; cancelled overrides
 * just remove theirs.
 */
export function expand(events: StoredEvent[], from: number, to: number): Occurrence[] {
  const overridden = new Set(events.filter((e) => e.recurrenceId).map((e) => `${e.calendarId}|${e.uid}|${e.recurrenceId}`));
  const out: Occurrence[] = [];
  const push = (e: StoredEvent, startWall: string, recurring: boolean) => {
    const tz = e.allDay ? null : e.tzid;
    const length = wallMs(e.endWall) - wallMs(e.startWall);
    const endWall = msWall(wallMs(startWall) + length);
    const start = wallToInstant(startWall, tz);
    const end = wallToInstant(endWall, tz);
    // All-day events are dates, not instants: allow a day either side for the viewer's zone.
    const hit = e.allDay ? start < to + DAY && Math.max(end, start + 1) > from - DAY : start < to && Math.max(end, start + 1) > from;
    if (!hit) return;
    out.push({
      id: `${e.id}|${startWall}`,
      eventId: e.id,
      calendarId: e.calendarId,
      uid: e.uid,
      occurrence: startWall,
      start: e.allDay ? startWall.slice(0, 10) : new Date(start).toISOString(),
      end: e.allDay ? endWall.slice(0, 10) : new Date(end).toISOString(),
      allDay: e.allDay,
      recurring,
      summary: e.summary,
      description: e.description,
      location: e.location,
      organizer: e.organizer,
      attendees: e.attendees,
      url: e.url,
      status: e.status,
      tzid: e.tzid,
    });
  };
  for (const e of events) {
    if (e.status === "cancelled") continue;
    if (!e.rrule) {
      push(e, e.startWall, !!e.recurrenceId);
      continue;
    }
    const length = wallMs(e.endWall) - wallMs(e.startWall);
    const skip = new Set(e.exdates);
    // Wall-clock window wide enough for any zone offset and the event's length.
    const dates = rule(e).between(new Date(from - length - 2 * DAY), new Date(to + 2 * DAY), true);
    for (const d of dates.slice(0, MAX_OCCURRENCES)) {
      const wall = msWall(d.getTime());
      if (skip.has(wall) || overridden.has(`${e.calendarId}|${e.uid}|${wall}`)) continue;
      push(e, wall, true);
    }
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

// ── Writing .ics ──

const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsWall = (wall: string, allDay: boolean) => (allDay ? wall.slice(0, 10).replace(/-/g, "") : wall.replace(/[-:]/g, ""));

/** Folds a content line at 75 octets (RFC 5545 §3.1). */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

export function toIcs(name: string, events: ParsedEvent[]): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//The AI Inc//Missive//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${escape(name)}`];
  const dt = (prop: string, wall: string, e: ParsedEvent) =>
    e.allDay ? `${prop};VALUE=DATE:${icsWall(wall, true)}` : e.tzid ? `${prop};TZID=${e.tzid}:${icsWall(wall, false)}` : `${prop}:${icsWall(wall, false)}Z`;
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${escape(e.uid)}`, `DTSTAMP:${stamp}`, dt("DTSTART", e.startWall, e), dt("DTEND", e.endWall, e));
    if (e.recurrenceId) lines.push(dt("RECURRENCE-ID", e.recurrenceId, e));
    if (e.rrule) lines.push(`RRULE:${e.rrule}`);
    for (const x of e.exdates) lines.push(dt("EXDATE", x, e));
    if (e.summary) lines.push(`SUMMARY:${escape(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${escape(e.description)}`);
    if (e.location) lines.push(`LOCATION:${escape(e.location)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    if (e.organizer) lines.push(`ORGANIZER:mailto:${e.organizer}`);
    for (const a of e.attendees) lines.push(`ATTENDEE${a.name ? `;CN="${a.name.replace(/"/g, "'")}"` : ""}${a.status ? `;PARTSTAT=${a.status.toUpperCase()}` : ""}:mailto:${a.email}`);
    lines.push(`STATUS:${e.status.toUpperCase()}`, `SEQUENCE:${e.sequence}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** A repeat from the event editor: none, or daily/weekly/monthly/yearly with an optional end date. */
export function simpleRrule(freq: string | null | undefined, until?: string | null): string | null {
  const f = String(freq ?? "").toUpperCase();
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(f)) return null;
  return until && /^\d{4}-\d{2}-\d{2}$/.test(until) ? `FREQ=${f};UNTIL=${until.replace(/-/g, "")}T235959Z` : `FREQ=${f}`;
}
