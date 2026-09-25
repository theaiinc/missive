import { describe, expect, it } from "vitest";
import { expand, instantToWall, parseIcs, span, toIcs, wallToInstant, type StoredEvent } from "../calendar/ical";
import { fromGoogle, fromOutlook } from "../calendar/providers";
import { feedUrl, isPrivateAddress } from "../calendar/calendar.service";

const ics = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:test\r\nX-WR-CALNAME:Team\r\n${body}END:VCALENDAR\r\n`;
const stored = (events: ReturnType<typeof parseIcs>["events"]): StoredEvent[] => events.map((e, i) => ({ ...e, id: `e${i}`, calendarId: "c1" }));

describe("time zones", () => {
  it("turns wall-clock time in a zone into the instant, across DST", () => {
    expect(new Date(wallToInstant("2026-01-15T09:00:00", "America/New_York")).toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(new Date(wallToInstant("2026-07-15T09:00:00", "America/New_York")).toISOString()).toBe("2026-07-15T13:00:00.000Z");
    expect(new Date(wallToInstant("2026-07-15T09:00:00", "Asia/Ho_Chi_Minh")).toISOString()).toBe("2026-07-15T02:00:00.000Z");
    expect(instantToWall(Date.parse("2026-07-15T13:00:00Z"), "America/New_York")).toBe("2026-07-15T09:00:00");
  });
});

describe("parseIcs", () => {
  it("reads a timed event with its zone, attendees and text", () => {
    const { name, events } = parseIcs(ics(
      "BEGIN:VEVENT\r\nUID:a@x\r\nDTSTART;TZID=Europe/Berlin:20261005T090000\r\nDTEND;TZID=Europe/Berlin:20261005T100000\r\n" +
      "SUMMARY:Standup\\, daily\r\nLOCATION:Room 1\r\nORGANIZER;CN=Ann:mailto:ann@x.com\r\nATTENDEE;CN=Bo;PARTSTAT=ACCEPTED:mailto:bo@x.com\r\nEND:VEVENT\r\n",
    ));
    expect(name).toBe("Team");
    expect(events[0]).toMatchObject({
      uid: "a@x", summary: "Standup, daily", location: "Room 1", startWall: "2026-10-05T09:00:00", endWall: "2026-10-05T10:00:00",
      tzid: "Europe/Berlin", allDay: false, organizer: "ann@x.com", attendees: [{ email: "bo@x.com", name: "Bo", status: "accepted" }],
    });
  });

  it("reads all-day events, UTC times and durations", () => {
    const { events } = parseIcs(ics(
      "BEGIN:VEVENT\r\nUID:d\r\nDTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261226\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\n" +
      "BEGIN:VEVENT\r\nUID:u\r\nDTSTART:20261005T070000Z\r\nDURATION:PT30M\r\nEND:VEVENT\r\n",
    ));
    expect(events[0]).toMatchObject({ allDay: true, startWall: "2026-12-24T00:00:00", endWall: "2026-12-26T00:00:00", tzid: null });
    expect(events[1]).toMatchObject({ allDay: false, startWall: "2026-10-05T07:00:00", endWall: "2026-10-05T07:30:00", tzid: null });
  });

  it("uses the file's VTIMEZONE for zone names that aren't IANA (Outlook)", () => {
    const { events } = parseIcs(ics(
      "BEGIN:VTIMEZONE\r\nTZID:SE Asia Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T000000\r\nTZOFFSETFROM:+0700\r\nTZOFFSETTO:+0700\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n" +
      "BEGIN:VEVENT\r\nUID:o\r\nDTSTART;TZID=SE Asia Standard Time:20261005T090000\r\nDTEND;TZID=SE Asia Standard Time:20261005T093000\r\nEND:VEVENT\r\n",
    ));
    expect(events[0]).toMatchObject({ startWall: "2026-10-05T02:00:00", endWall: "2026-10-05T02:30:00", tzid: null });
  });

  it("rejects a file that isn't iCalendar", () => {
    expect(() => parseIcs("hello")).toThrow();
  });
});

describe("repeating events", () => {
  const weekly = parseIcs(ics(
    "BEGIN:VEVENT\r\nUID:w\r\nDTSTART;TZID=America/New_York:20261005T090000\r\nDTEND;TZID=America/New_York:20261005T093000\r\n" +
    "RRULE:FREQ=WEEKLY;COUNT=6\r\nEXDATE;TZID=America/New_York:20261019T090000\r\nSUMMARY:Weekly\r\nEND:VEVENT\r\n" +
    "BEGIN:VEVENT\r\nUID:w\r\nRECURRENCE-ID;TZID=America/New_York:20261026T090000\r\nDTSTART;TZID=America/New_York:20261026T110000\r\n" +
    "DTEND;TZID=America/New_York:20261026T113000\r\nSUMMARY:Weekly (moved)\r\nEND:VEVENT\r\n",
  )).events;

  it("stays at 9:00 local across the DST change, skips EXDATEs and uses overrides", () => {
    const occ = expand(stored(weekly), Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-12-01T00:00:00Z"));
    expect(occ.map((o) => [o.start, o.summary])).toEqual([
      ["2026-10-05T13:00:00.000Z", "Weekly"],
      ["2026-10-12T13:00:00.000Z", "Weekly"],
      ["2026-10-26T15:00:00.000Z", "Weekly (moved)"],
      ["2026-11-02T14:00:00.000Z", "Weekly"], // after DST ends: still 9:00 in New York
      ["2026-11-09T14:00:00.000Z", "Weekly"],
    ]);
  });

  it("knows when a counted series ends, and that an open one doesn't", () => {
    expect(new Date(span(weekly[0]!).untilAt!).toISOString()).toBe("2026-11-09T14:30:00.000Z");
    const [forever] = parseIcs(ics("BEGIN:VEVENT\r\nUID:f\r\nDTSTART:20260101T090000Z\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\n")).events;
    expect(span(forever!).untilAt).toBeNull();
  });

  it("only returns occurrences inside the range", () => {
    const occ = expand(stored(weekly), Date.parse("2026-11-01T00:00:00Z"), Date.parse("2026-11-05T00:00:00Z"));
    expect(occ.map((o) => o.start)).toEqual(["2026-11-02T14:00:00.000Z"]);
  });
});

describe("toIcs", () => {
  it("writes what parseIcs reads back", () => {
    const { events } = parseIcs(ics(
      "BEGIN:VEVENT\r\nUID:r\r\nDTSTART;TZID=Asia/Ho_Chi_Minh:20261005T090000\r\nDTEND;TZID=Asia/Ho_Chi_Minh:20261005T100000\r\n" +
      "RRULE:FREQ=WEEKLY\r\nSUMMARY:Sync\\; notes\r\nDESCRIPTION:Line one\\nLine two\r\nEND:VEVENT\r\n",
    ));
    const again = parseIcs(toIcs("Mine", events));
    expect(again.name).toBe("Mine");
    expect(again.events[0]).toMatchObject({ uid: "r", summary: "Sync; notes", description: "Line one\nLine two", tzid: "Asia/Ho_Chi_Minh", rrule: "FREQ=WEEKLY" });
  });
});

describe("connected accounts", () => {
  it("maps Google events, skipping cancelled ones", () => {
    expect(fromGoogle({ id: "g1", summary: "Call", start: { dateTime: "2026-10-05T09:00:00+07:00" }, end: { dateTime: "2026-10-05T09:30:00+07:00" } }))
      .toMatchObject({ uid: "g1", startWall: "2026-10-05T02:00:00", endWall: "2026-10-05T02:30:00", tzid: null, allDay: false });
    expect(fromGoogle({ id: "g2", start: { date: "2026-10-06" }, end: { date: "2026-10-07" } })).toMatchObject({ allDay: true, startWall: "2026-10-06T00:00:00" });
    expect(fromGoogle({ id: "g3", status: "cancelled", start: { date: "2026-10-06" } })).toBeNull();
  });

  it("maps Microsoft events (asked for in UTC)", () => {
    expect(fromOutlook({ id: "m1", subject: "Review", start: { dateTime: "2026-10-05T02:00:00.0000000" }, end: { dateTime: "2026-10-05T03:00:00.0000000" } }))
      .toMatchObject({ uid: "m1", summary: "Review", startWall: "2026-10-05T02:00:00", endWall: "2026-10-05T03:00:00" });
    expect(fromOutlook({ id: "m2", isCancelled: true, start: { dateTime: "2026-10-05T02:00:00" } })).toBeNull();
  });
});

describe("subscription links", () => {
  it("treats webcal as https and refuses other schemes", () => {
    expect(feedUrl("webcal://example.com/cal.ics").toString()).toBe("https://example.com/cal.ics");
    expect(() => feedUrl("file:///etc/passwd")).toThrow();
    expect(() => feedUrl("https://user:pw@example.com/x.ics")).toThrow();
  });

  it("recognises private and local addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});
