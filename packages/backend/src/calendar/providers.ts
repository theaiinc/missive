import type { ParsedEvent } from "./ical";
import { msWall } from "./ical";

/**
 * Calendars of connected accounts (Google via Gmail's connection, Microsoft
 * via Outlook's), read-only. Each provider hands back occurrences already
 * expanded for a window, so they're stored as single events in UTC and
 * replaced on every refresh; repeats, exceptions and time zones are the
 * provider's job.
 */

export type ProviderCalendar = { externalId: string; name: string; color: string | null; primary: boolean };

/** The account didn't grant calendar access (connected before Missive asked for it). */
export class NeedsReconnect extends Error {}

export const WINDOW_BACK_DAYS = 90;
export const WINDOW_AHEAD_DAYS = 365;

async function getJson<T>(url: string, token: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ...headers } });
  if (res.status === 401 || res.status === 403) {
    const body = await res.text();
    if (/insufficient|scope|consent|Authorization_RequestDenied|AccessDenied|ErrorAccessDenied/i.test(body) || res.status === 403) {
      throw new NeedsReconnect("Calendar access wasn't granted for this account. Reconnect it to sync its calendars.");
    }
    throw new Error(`Calendar request failed (${res.status})`);
  }
  if (!res.ok) throw new Error(`Calendar request failed (${res.status})`);
  return res.json() as Promise<T>;
}

const window = (now: number) => ({
  from: new Date(now - WINDOW_BACK_DAYS * 86_400_000).toISOString(),
  to: new Date(now + WINDOW_AHEAD_DAYS * 86_400_000).toISOString(),
});

const MAX_PAGES = 20;

// ── Google Calendar ──

type GTime = { date?: string; dateTime?: string; timeZone?: string };
type GEvent = {
  id: string; iCalUID?: string; status?: string; summary?: string; description?: string; location?: string; htmlLink?: string;
  start?: GTime; end?: GTime; organizer?: { email?: string }; sequence?: number;
  attendees?: { email?: string; displayName?: string; responseStatus?: string }[];
};

export async function googleCalendars(token: string): Promise<ProviderCalendar[]> {
  const r = await getJson<{ items?: { id: string; summary?: string; summaryOverride?: string; backgroundColor?: string; primary?: boolean }[] }>(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=50",
    token,
  );
  return (r.items ?? []).map((c) => ({ externalId: c.id, name: c.summaryOverride ?? c.summary ?? c.id, color: c.backgroundColor ?? null, primary: !!c.primary }));
}

const gWall = (t: GTime | undefined): { wall: string; allDay: boolean } | null => {
  if (t?.date) return { wall: `${t.date}T00:00:00`, allDay: true };
  if (t?.dateTime) return { wall: msWall(Date.parse(t.dateTime)), allDay: false };
  return null;
};

export function fromGoogle(e: GEvent): ParsedEvent | null {
  const start = gWall(e.start);
  const end = gWall(e.end) ?? start;
  if (!start || !end || e.status === "cancelled") return null;
  return {
    uid: e.id,
    recurrenceId: "",
    summary: e.summary ?? null,
    description: e.description ?? null,
    location: e.location ?? null,
    organizer: e.organizer?.email ?? null,
    attendees: (e.attendees ?? []).filter((a) => a.email).map((a) => ({ email: a.email!, ...(a.displayName ? { name: a.displayName } : {}), ...(a.responseStatus ? { status: a.responseStatus } : {}) })),
    url: e.htmlLink ?? null,
    startWall: start.wall,
    endWall: end.wall,
    tzid: null,
    allDay: start.allDay,
    rrule: null,
    exdates: [],
    status: e.status ?? "confirmed",
    sequence: e.sequence ?? 0,
  };
}

export async function googleEvents(token: string, calendarId: string, now = Date.now()): Promise<ParsedEvent[]> {
  const { from, to } = window(now);
  const out: ParsedEvent[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = new URLSearchParams({ singleEvents: "true", timeMin: from, timeMax: to, maxResults: "2500", orderBy: "startTime" });
    if (pageToken) q.set("pageToken", pageToken);
    const r = await getJson<{ items?: GEvent[]; nextPageToken?: string }>(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${q}`,
      token,
    );
    for (const e of r.items ?? []) {
      const p = fromGoogle(e);
      if (p) out.push(p);
    }
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

// ── Microsoft Graph ──

type MEvent = {
  id: string; subject?: string; bodyPreview?: string; isAllDay?: boolean; isCancelled?: boolean; showAs?: string; webLink?: string;
  start?: { dateTime: string }; end?: { dateTime: string }; location?: { displayName?: string };
  organizer?: { emailAddress?: { address?: string } };
  attendees?: { emailAddress?: { address?: string; name?: string }; status?: { response?: string } }[];
};

export async function outlookCalendars(token: string): Promise<ProviderCalendar[]> {
  const r = await getJson<{ value?: { id: string; name?: string; hexColor?: string; isDefaultCalendar?: boolean }[] }>(
    "https://graph.microsoft.com/v1.0/me/calendars?$top=50&$select=id,name,hexColor,isDefaultCalendar",
    token,
  );
  return (r.value ?? []).map((c) => ({ externalId: c.id, name: c.name ?? "Calendar", color: c.hexColor || null, primary: !!c.isDefaultCalendar }));
}

// Graph returns "2026-10-05T09:00:00.0000000" in the zone asked for (UTC here).
const mWall = (s: string | undefined) => (s ? s.slice(0, 19) : null);

export function fromOutlook(e: MEvent): ParsedEvent | null {
  const start = mWall(e.start?.dateTime);
  const end = mWall(e.end?.dateTime) ?? start;
  if (!start || !end || e.isCancelled) return null;
  const allDay = !!e.isAllDay;
  return {
    uid: e.id,
    recurrenceId: "",
    summary: e.subject ?? null,
    description: e.bodyPreview || null,
    location: e.location?.displayName || null,
    organizer: e.organizer?.emailAddress?.address ?? null,
    attendees: (e.attendees ?? []).filter((a) => a.emailAddress?.address).map((a) => ({
      email: a.emailAddress!.address!, ...(a.emailAddress?.name ? { name: a.emailAddress.name } : {}), ...(a.status?.response ? { status: a.status.response } : {}),
    })),
    url: e.webLink ?? null,
    // All-day events are dates: keep the date as written rather than shifting it through UTC.
    startWall: allDay ? `${start.slice(0, 10)}T00:00:00` : start,
    endWall: allDay ? `${end.slice(0, 10)}T00:00:00` : end,
    tzid: null,
    allDay,
    rrule: null,
    exdates: [],
    status: e.showAs === "tentative" ? "tentative" : "confirmed",
    sequence: 0,
  };
}

export async function outlookEvents(token: string, calendarId: string, now = Date.now()): Promise<ParsedEvent[]> {
  const { from, to } = window(now);
  const out: ParsedEvent[] = [];
  let url: string | undefined =
    `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView?` +
    new URLSearchParams({
      startDateTime: from, endDateTime: to, $top: "500",
      $select: "id,subject,bodyPreview,isAllDay,isCancelled,showAs,webLink,start,end,location,organizer,attendees",
    });
  for (let i = 0; url && i < MAX_PAGES; i++) {
    const r: { value?: MEvent[]; "@odata.nextLink"?: string } = await getJson(url, token, { Prefer: 'outlook.timezone="UTC"' });
    for (const e of r.value ?? []) {
      const p = fromOutlook(e);
      if (p) out.push(p);
    }
    url = r["@odata.nextLink"];
  }
  return out;
}
