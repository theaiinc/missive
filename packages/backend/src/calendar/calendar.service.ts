import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { PostgresService } from "../storage/postgres.service";
import { openRows, seal } from "../storage/content-crypto";
import { ConnectorStore, type StoredConnector } from "../connector.store";
import { safeError } from "../log-safe";
import { expand, instantToWall, isIana, msWall, parseIcs, simpleRrule, span, toIcs, wallMs, type Occurrence, type ParsedEvent, type StoredEvent } from "./ical";
import { NeedsReconnect, googleCalendars, googleEvents, outlookCalendars, outlookEvents, type ProviderCalendar } from "./providers";

export type CalendarSource = "local" | "url" | "gmail" | "outlook";
export type Calendar = {
  id: string; name: string; color: string; source: CalendarSource; sourceUrl: string | null; connectorId: string | null;
  visible: boolean; readOnly: boolean; lastSyncedAt: string | null; lastError: string | null;
};
export type EventInput = {
  calendarId: string; summary?: string | null; description?: string | null; location?: string | null;
  start: string; end: string; allDay?: boolean; timeZone?: string | null; repeat?: string | null; repeatUntil?: string | null;
};

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#64748b"];
const MAX_ICS_BYTES = 10 * 1024 * 1024;
const URL_REFRESH_MS = 60 * 60_000;
const ACCOUNT_REFRESH_MS = 30 * 60_000;
const CHUNK = 200;

const isoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const validColor = (c: unknown) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : null);

/** Private, loopback, link-local and other non-public addresses a feed link must not reach. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") ||
    v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("ff");
}

/** webcal:// is https://; only public http(s) hosts. */
export function feedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/^webcals?:\/\//i, "https://"));
  } catch {
    throw new BadRequestException("That isn't a valid link");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new BadRequestException("Only http(s) and webcal links");
  if (url.username || url.password) throw new BadRequestException("Links with a user name or password aren't supported");
  return url;
}

async function fetchFeed(raw: string): Promise<string> {
  let url = feedUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
    if (!addresses.length) throw new BadRequestException(`Couldn't find ${host}`);
    if (addresses.some((a) => isPrivateAddress(a.address))) throw new BadRequestException("That link points at a private network address");
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { accept: "text/calendar, */*" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = feedUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    if (!res.ok) throw new BadRequestException(`The calendar link answered ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_ICS_BYTES) throw new BadRequestException("That calendar is larger than 10 MB");
    const text = await res.text();
    if (text.length > MAX_ICS_BYTES) throw new BadRequestException("That calendar is larger than 10 MB");
    return text;
  }
  throw new BadRequestException("Too many redirects");
}

function parse(text: string) {
  try {
    return parseIcs(text);
  } catch (e) {
    throw new BadRequestException(`Couldn't read that calendar file: ${e instanceof Error ? e.message : String(e)}`);
  }
}

@Injectable()
export class CalendarService {
  private readonly log = new Logger("Calendar");

  constructor(
    private readonly pg: PostgresService,
    private readonly connectors: ConnectorStore,
  ) {}

  // ── Calendars ──

  async list(): Promise<Calendar[]> {
    const { rows } = await this.pg.query(`SELECT * FROM calendars ORDER BY created_at`);
    const open = await openRows("calendars", rows);
    return open.map((r: any) => ({
      id: r.id, name: r.name, color: r.color, source: r.source, sourceUrl: r.source_url ?? null, connectorId: r.connector_id ?? null,
      visible: r.visible, readOnly: r.source !== "local", lastSyncedAt: r.last_synced_at?.toISOString?.() ?? null, lastError: r.last_error ?? null,
    }));
  }

  private async get(id: string): Promise<Calendar> {
    const c = (await this.list()).find((x) => x.id === id);
    if (!c) throw new NotFoundException("No such calendar");
    return c;
  }

  private async nextColor(): Promise<string> {
    const { rows } = await this.pg.query(`SELECT count(*)::int AS n FROM calendars`);
    return COLORS[(rows[0]?.n ?? 0) % COLORS.length]!;
  }

  async create(input: { name: string; color?: string | null; source?: CalendarSource; sourceUrl?: string | null; connectorId?: string | null; externalId?: string | null }): Promise<Calendar> {
    const name = String(input.name ?? "").trim().slice(0, 120);
    if (!name) throw new BadRequestException("A calendar needs a name");
    const { rows } = await this.pg.query(
      `INSERT INTO calendars (name, color, source, source_url, connector_id, external_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        await seal("calendars", "name", name), validColor(input.color) ?? (await this.nextColor()), input.source ?? "local",
        await seal("calendars", "source_url", input.sourceUrl ?? null), input.connectorId ?? null, await seal("calendars", "external_id", input.externalId ?? null),
      ],
    );
    return this.get(rows[0].id);
  }

  async update(id: string, patch: { name?: string; color?: string; visible?: boolean }): Promise<Calendar> {
    await this.get(id);
    if (patch.name !== undefined) {
      const name = String(patch.name).trim().slice(0, 120);
      if (!name) throw new BadRequestException("A calendar needs a name");
      await this.pg.query(`UPDATE calendars SET name = $2, updated_at = NOW() WHERE id = $1`, [id, await seal("calendars", "name", name)]);
    }
    if (validColor(patch.color)) await this.pg.query(`UPDATE calendars SET color = $2, updated_at = NOW() WHERE id = $1`, [id, patch.color]);
    if (typeof patch.visible === "boolean") await this.pg.query(`UPDATE calendars SET visible = $2, updated_at = NOW() WHERE id = $1`, [id, patch.visible]);
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    await this.pg.query(`DELETE FROM calendars WHERE id = $1`, [id]);
  }

  // ── Writing events ──

  /**
   * Upserts events into a calendar (by UID and recurrence id). With
   * `replace`, events the source no longer has are removed too.
   */
  private async write(calendarId: string, events: ParsedEvent[], replace: boolean): Promise<number> {
    let written = 0;
    for (let i = 0; i < events.length; i += CHUNK) {
      const rows = [];
      for (const e of events.slice(i, i + CHUNK)) {
        const { startsAt, untilAt } = span(e);
        rows.push({
          calendar_id: calendarId, uid: e.uid.slice(0, 1000), recurrence_id: e.recurrenceId,
          summary: await seal("calendar_events", "summary", e.summary?.slice(0, 1000) ?? null),
          description: await seal("calendar_events", "description", e.description?.slice(0, 20_000) ?? null),
          location: await seal("calendar_events", "location", e.location?.slice(0, 1000) ?? null),
          organizer: await seal("calendar_events", "organizer", e.organizer),
          attendees: await seal("calendar_events", "attendees", JSON.stringify(e.attendees.slice(0, 200))),
          url: await seal("calendar_events", "url", e.url),
          start_wall: e.startWall, end_wall: e.endWall, tzid: e.tzid, all_day: e.allDay, rrule: e.rrule, exdates: e.exdates,
          status: e.status, sequence: e.sequence,
          starts_at: new Date(startsAt).toISOString(), until_at: untilAt == null ? null : new Date(untilAt).toISOString(),
        });
      }
      await this.pg.query(
        `INSERT INTO calendar_events (calendar_id, uid, recurrence_id, summary, description, location, organizer, attendees, url,
                                      start_wall, end_wall, tzid, all_day, rrule, exdates, status, sequence, starts_at, until_at)
         SELECT x.calendar_id, x.uid, x.recurrence_id, x.summary, x.description, x.location, x.organizer, x.attendees, x.url,
                x.start_wall, x.end_wall, x.tzid, x.all_day, x.rrule, COALESCE(x.exdates, '{}'), x.status, x.sequence, x.starts_at, x.until_at
           FROM jsonb_to_recordset($1::jsonb) AS x(calendar_id uuid, uid text, recurrence_id text, summary text, description text, location text,
                organizer text, attendees text, url text, start_wall timestamp, end_wall timestamp, tzid text, all_day boolean, rrule text,
                exdates text[], status text, sequence int, starts_at timestamptz, until_at timestamptz)
         ON CONFLICT (owner_id, calendar_id, uid, recurrence_id) DO UPDATE SET
           summary = EXCLUDED.summary, description = EXCLUDED.description, location = EXCLUDED.location, organizer = EXCLUDED.organizer,
           attendees = EXCLUDED.attendees, url = EXCLUDED.url, start_wall = EXCLUDED.start_wall, end_wall = EXCLUDED.end_wall,
           tzid = EXCLUDED.tzid, all_day = EXCLUDED.all_day, rrule = EXCLUDED.rrule, exdates = EXCLUDED.exdates, status = EXCLUDED.status,
           sequence = EXCLUDED.sequence, starts_at = EXCLUDED.starts_at, until_at = EXCLUDED.until_at, updated_at = NOW()`,
        [JSON.stringify(rows)],
      );
      written += rows.length;
    }
    if (replace) {
      await this.pg.query(
        `DELETE FROM calendar_events WHERE calendar_id = $1 AND NOT ((uid || '|' || recurrence_id) = ANY($2::text[]))`,
        [calendarId, events.map((e) => `${e.uid.slice(0, 1000)}|${e.recurrenceId}`)],
      );
    }
    return written;
  }

  // ── .ics import and subscriptions ──

  /** Imports an .ics file into `calendarId` (a calendar of yours), or into a new calendar named after the file. */
  async importIcs(text: string, opts: { calendarId?: string | null; name?: string | null }): Promise<{ calendar: Calendar; imported: number }> {
    if (!text?.trim()) throw new BadRequestException("The file is empty");
    if (text.length > MAX_ICS_BYTES) throw new BadRequestException("That calendar is larger than 10 MB");
    const parsed = parse(text);
    let calendar: Calendar;
    if (opts.calendarId) {
      calendar = await this.get(opts.calendarId);
      if (calendar.readOnly) throw new BadRequestException("Import into one of your own calendars (this one is synced)");
    } else {
      calendar = await this.create({ name: opts.name?.trim() || parsed.name || "Imported" });
    }
    const imported = await this.write(calendar.id, parsed.events, false);
    return { calendar, imported };
  }

  async subscribe(input: { url: string; name?: string | null; color?: string | null }): Promise<{ calendar: Calendar; imported: number }> {
    const text = await fetchFeed(input.url);
    const parsed = parse(text);
    const calendar = await this.create({ name: input.name?.trim() || parsed.name || feedUrl(input.url).hostname, color: input.color, source: "url", sourceUrl: input.url.trim() });
    const imported = await this.write(calendar.id, parsed.events, true);
    await this.pg.query(`UPDATE calendars SET last_synced_at = NOW(), last_error = NULL WHERE id = $1`, [calendar.id]);
    return { calendar: await this.get(calendar.id), imported };
  }

  async refresh(id: string): Promise<Calendar> {
    const calendar = await this.get(id);
    if (calendar.source === "url") {
      try {
        const parsed = parse(await fetchFeed(calendar.sourceUrl ?? ""));
        await this.write(id, parsed.events, true);
        await this.pg.query(`UPDATE calendars SET last_synced_at = NOW(), last_error = NULL WHERE id = $1`, [id]);
      } catch (e) {
        await this.pg.query(`UPDATE calendars SET last_error = $2 WHERE id = $1`, [id, (e instanceof Error ? e.message : String(e)).slice(0, 300)]);
      }
    } else if (calendar.connectorId) {
      await this.syncAccount(calendar.connectorId);
    }
    return this.get(id);
  }

  // ── Connected accounts ──

  /** The connected Gmail and Outlook accounts and how their calendar sync is doing. */
  async accounts() {
    const [connectors, state] = await Promise.all([
      this.connectors.listAll(),
      this.pg.query(`SELECT connector_id, last_synced_at, last_error FROM calendar_accounts`),
    ]);
    const byId = new Map(state.rows.map((r: any) => [r.connector_id, r]));
    return connectors
      .filter((c) => c.provider === "gmail" || c.provider === "outlook")
      .map((c) => {
        const s: any = byId.get(c.id);
        return { connectorId: c.id, provider: c.provider, email: c.email, lastSyncedAt: s?.last_synced_at?.toISOString?.() ?? null, lastError: s?.last_error ?? null };
      });
  }

  private async token(c: StoredConnector): Promise<string> {
    return c.provider === "gmail" ? this.connectors.getValidGmailToken(c.id) : this.connectors.getValidOutlookToken(c.id);
  }

  /**
   * Copies one connected account's calendars: a Missive calendar per account
   * calendar (made on first sync, removed when the account drops it), each
   * refilled with the events from 90 days back to a year ahead.
   */
  async syncAccount(connectorId: string): Promise<{ calendars: number; events: number }> {
    const connector = await this.connectors.get(connectorId);
    if (!connector || (connector.provider !== "gmail" && connector.provider !== "outlook")) throw new NotFoundException("No such account");
    const provider = connector.provider as "gmail" | "outlook";
    try {
      const token = await this.token(connector);
      const remote: ProviderCalendar[] = provider === "gmail" ? await googleCalendars(token) : await outlookCalendars(token);
      const { rows } = await this.pg.query(`SELECT id, owner_id, external_id FROM calendars WHERE connector_id = $1`, [connectorId]);
      const local = new Map((await openRows("calendars", rows)).map((r: any) => [r.external_id as string, r.id as string]));
      let events = 0;
      for (const rc of remote.slice(0, 25)) {
        let id = local.get(rc.externalId);
        if (!id) {
          const name = rc.primary ? connector.email : rc.name;
          id = (await this.create({ name, color: validColor(rc.color), source: provider, connectorId, externalId: rc.externalId })).id;
        }
        local.delete(rc.externalId);
        try {
          const list = provider === "gmail" ? await googleEvents(token, rc.externalId) : await outlookEvents(token, rc.externalId);
          events += await this.write(id, list, true);
          await this.pg.query(`UPDATE calendars SET last_synced_at = NOW(), last_error = NULL WHERE id = $1`, [id]);
        } catch (e) {
          if (e instanceof NeedsReconnect) throw e;
          await this.pg.query(`UPDATE calendars SET last_error = $2 WHERE id = $1`, [id, (e instanceof Error ? e.message : String(e)).slice(0, 300)]);
        }
      }
      // Calendars the account no longer has (or unsubscribed from).
      for (const gone of local.values()) await this.remove(gone);
      await this.setAccountState(connectorId, null);
      return { calendars: Math.min(remote.length, 25), events };
    } catch (e) {
      const message = e instanceof NeedsReconnect ? e.message : `Calendar sync failed: ${e instanceof Error ? e.message : String(e)}`;
      await this.setAccountState(connectorId, message.slice(0, 300));
      if (e instanceof NeedsReconnect) return { calendars: 0, events: 0 };
      throw e;
    }
  }

  private async setAccountState(connectorId: string, error: string | null) {
    await this.pg.query(
      `INSERT INTO calendar_accounts (connector_id, last_synced_at, last_error) VALUES ($1, CASE WHEN $2::text IS NULL THEN NOW() END, $2)
       ON CONFLICT (owner_id, connector_id) DO UPDATE SET
         last_synced_at = COALESCE(CASE WHEN $2::text IS NULL THEN NOW() END, calendar_accounts.last_synced_at), last_error = $2`,
      [connectorId, error],
    );
  }

  /** Background refresh (SyncScheduler): subscriptions hourly, connected accounts every 30 minutes. */
  async refreshDue(now = Date.now()): Promise<void> {
    const cals = await this.list();
    for (const c of cals) {
      if (c.source === "url" && (!c.lastSyncedAt || now - Date.parse(c.lastSyncedAt) > URL_REFRESH_MS)) {
        await this.refresh(c.id).catch((e) => this.log.warn(`Calendar refresh failed: ${safeError(e)}`));
      }
    }
    for (const a of await this.accounts()) {
      const due = !a.lastSyncedAt || now - Date.parse(a.lastSyncedAt) > ACCOUNT_REFRESH_MS;
      // An account that needs reconnecting is retried less often (it'll fail the same way until then).
      const waiting = a.lastError && a.lastSyncedAt && now - Date.parse(a.lastSyncedAt) < 6 * ACCOUNT_REFRESH_MS;
      if (due && !waiting) await this.syncAccount(a.connectorId).catch((e) => this.log.warn(`Account calendar sync failed: ${safeError(e)}`));
    }
  }

  // ── Reading ──

  private async stored(where: string, params: unknown[]): Promise<StoredEvent[]> {
    const { rows } = await this.pg.query(
      `SELECT e.id, e.owner_id, e.calendar_id, e.uid, e.recurrence_id, e.summary, e.description, e.location, e.organizer, e.attendees, e.url,
              to_char(e.start_wall, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_wall, to_char(e.end_wall, 'YYYY-MM-DD"T"HH24:MI:SS') AS end_wall,
              e.tzid, e.all_day, e.rrule, e.exdates, e.status, e.sequence
         FROM calendar_events e ${where}`,
      params,
    );
    const open = await openRows("calendar_events", rows);
    return open.map((r: any) => {
      let attendees = [];
      try { attendees = JSON.parse(r.attendees ?? "[]"); } catch { attendees = []; }
      return {
        id: r.id, calendarId: r.calendar_id, uid: r.uid, recurrenceId: r.recurrence_id, summary: r.summary, description: r.description,
        location: r.location, organizer: r.organizer, attendees, url: r.url, startWall: r.start_wall, endWall: r.end_wall, tzid: r.tzid,
        allDay: r.all_day, rrule: r.rrule, exdates: r.exdates ?? [], status: r.status, sequence: r.sequence,
      };
    });
  }

  /** Occurrences in [from, to) on visible calendars. */
  async events(from: string, to: string): Promise<Occurrence[]> {
    const f = Date.parse(from), t = Date.parse(to);
    if (!Number.isFinite(f) || !Number.isFinite(t) || t <= f) throw new BadRequestException("from and to must be dates, from before to");
    if (t - f > 400 * 86_400_000) throw new BadRequestException("Ask for at most about a year at a time");
    // A day's slack each side covers all-day events, which are dates rather than instants.
    const events = await this.stored(
      `JOIN calendars c ON c.owner_id = e.owner_id AND c.id = e.calendar_id
        WHERE c.visible AND e.starts_at < $2 AND (e.until_at IS NULL OR e.until_at >= $1)`,
      [new Date(f - 86_400_000).toISOString(), new Date(t + 86_400_000).toISOString()],
    );
    // Overrides of a series need the series (and vice versa) even when only one falls in range.
    const uids = [...new Set(events.filter((e) => e.rrule || e.recurrenceId).map((e) => e.uid))];
    const related = uids.length
      ? await this.stored(`WHERE e.uid = ANY($1::text[]) AND (e.rrule IS NOT NULL OR e.recurrence_id <> '')`, [uids])
      : [];
    const byId = new Map([...events, ...related].map((e) => [e.id, e]));
    return expand([...byId.values()], f, t);
  }

  async exportIcs(id: string): Promise<{ name: string; ics: string }> {
    const calendar = await this.get(id);
    return { name: calendar.name, ics: toIcs(calendar.name, await this.stored(`WHERE e.calendar_id = $1`, [id])) };
  }

  // ── Your own events ──

  private async editable(calendarId: string): Promise<Calendar> {
    const c = await this.get(calendarId);
    if (c.readOnly) throw new BadRequestException("This calendar is synced from elsewhere, so its events can only be changed there");
    return c;
  }

  private toParsed(input: EventInput, uid: string, sequence: number): ParsedEvent {
    const allDay = !!input.allDay;
    const tz = !allDay && isIana(input.timeZone) ? input.timeZone : null;
    let startWall: string, endWall: string;
    if (allDay) {
      if (!isoDate(input.start) || !isoDate(input.end)) throw new BadRequestException("All-day events take dates");
      startWall = `${input.start}T00:00:00`;
      // The editor sends the last day; iCalendar ends all-day events the day after.
      endWall = msWall(wallMs(`${input.end}T00:00:00`) + 86_400_000);
    } else {
      const s = Date.parse(input.start), e = Date.parse(input.end);
      if (!Number.isFinite(s) || !Number.isFinite(e)) throw new BadRequestException("Start and end must be times");
      startWall = instantToWall(s, tz);
      endWall = instantToWall(e, tz);
    }
    if (wallMs(endWall) < wallMs(startWall)) throw new BadRequestException("The event ends before it starts");
    return {
      uid, recurrenceId: "", summary: input.summary?.trim() || null, description: input.description?.trim() || null, location: input.location?.trim() || null,
      organizer: null, attendees: [], url: null, startWall, endWall, tzid: tz, allDay, rrule: simpleRrule(input.repeat, input.repeatUntil),
      exdates: [], status: "confirmed", sequence,
    };
  }

  async createEvent(input: EventInput): Promise<{ id: string }> {
    await this.editable(input.calendarId);
    const uid = `${randomUUID()}@missive`;
    await this.write(input.calendarId, [this.toParsed(input, uid, 0)], false);
    const { rows } = await this.pg.query(`SELECT id FROM calendar_events WHERE calendar_id = $1 AND uid = $2 AND recurrence_id = ''`, [input.calendarId, uid]);
    return { id: rows[0].id };
  }

  /** Changes an event (for a repeating one, the whole series), possibly moving it to another of your calendars. */
  async updateEvent(id: string, input: EventInput): Promise<{ id: string }> {
    const [current] = await this.stored(`WHERE e.id = $1`, [id]);
    if (!current) throw new NotFoundException("No such event");
    await this.editable(current.calendarId);
    await this.editable(input.calendarId);
    const next = this.toParsed(input, current.uid, current.sequence + 1);
    // Keep skipped occurrences that still fall on the (unchanged) pattern.
    if (next.rrule && next.rrule === current.rrule && next.startWall === current.startWall) next.exdates = current.exdates;
    if (input.calendarId !== current.calendarId) {
      await this.pg.query(`DELETE FROM calendar_events WHERE id = $1`, [id]);
      await this.write(input.calendarId, [next], false);
      const { rows } = await this.pg.query(`SELECT id FROM calendar_events WHERE calendar_id = $1 AND uid = $2 AND recurrence_id = ''`, [input.calendarId, current.uid]);
      return { id: rows[0].id };
    }
    await this.write(current.calendarId, [next], false);
    return { id };
  }

  /** Deletes an event, or with `occurrence` (its wall start) just that one occurrence of a repeating event. */
  async deleteEvent(id: string, occurrence?: string | null): Promise<void> {
    const [current] = await this.stored(`WHERE e.id = $1`, [id]);
    if (!current) throw new NotFoundException("No such event");
    await this.editable(current.calendarId);
    if (occurrence && current.rrule) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(occurrence)) throw new BadRequestException("Bad occurrence");
      await this.pg.query(`UPDATE calendar_events SET exdates = array_append(exdates, $2), updated_at = NOW() WHERE id = $1`, [id, occurrence]);
      return;
    }
    await this.pg.query(`DELETE FROM calendar_events WHERE id = $1`, [id]);
  }
}
