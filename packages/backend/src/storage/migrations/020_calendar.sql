-- Calendar: each person's calendars and events, owned and isolated like mail
-- (row-level security on owner_id; see 010_users_and_mailboxes.sql).
--
-- A calendar is the person's own ("local": events made here or imported from
-- an .ics file), a subscription to an .ics link, or one of a connected Google
-- or Microsoft account's calendars (read-only copies, refreshed from them). Events
-- keep the times as written (wall-clock time plus its time zone) so repeating
-- events stay at the same local time across daylight-saving changes; starts_at
-- and until_at are real instants for finding what falls in a range.

CREATE TABLE IF NOT EXISTS calendars (
    owner_id        UUID NOT NULL REFERENCES users(id) DEFAULT NULLIF(current_setting('app.user_id', true), '')::uuid,
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,             -- encrypted
    color           TEXT NOT NULL DEFAULT '#3b82f6',
    source          TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'url', 'gmail', 'outlook')),
    source_url      TEXT,                      -- encrypted (a private feed link is a secret)
    connector_id    TEXT,                      -- connectors.id, for a connected account's calendar
    external_id     TEXT,                      -- encrypted: that account's id for the calendar (often an address)
    visible         BOOLEAN NOT NULL DEFAULT true,
    last_synced_at  TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id)
);

CREATE TABLE IF NOT EXISTS calendar_events (
    owner_id        UUID NOT NULL REFERENCES users(id) DEFAULT NULLIF(current_setting('app.user_id', true), '')::uuid,
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    calendar_id     UUID NOT NULL,
    uid             TEXT NOT NULL,             -- iCalendar UID
    recurrence_id   TEXT NOT NULL DEFAULT '',  -- '' for a series or single event; the original occurrence (wall time) for an override
    summary         TEXT,                      -- encrypted
    description     TEXT,                      -- encrypted
    location        TEXT,                      -- encrypted
    organizer       TEXT,                      -- encrypted
    attendees       TEXT,                      -- encrypted JSON
    url             TEXT,                      -- encrypted
    start_wall      TIMESTAMP NOT NULL,        -- as written, in tzid
    end_wall        TIMESTAMP NOT NULL,
    tzid            TEXT,                      -- IANA zone; NULL = UTC; all-day events ignore it
    all_day         BOOLEAN NOT NULL DEFAULT false,
    rrule           TEXT,                      -- RRULE value, e.g. FREQ=WEEKLY;BYDAY=MO
    exdates         TEXT[] NOT NULL DEFAULT '{}',  -- skipped occurrences (wall time, ISO)
    status          TEXT NOT NULL DEFAULT 'confirmed',
    sequence        INTEGER NOT NULL DEFAULT 0,
    starts_at       TIMESTAMPTZ NOT NULL,      -- first occurrence
    until_at        TIMESTAMPTZ,               -- last occurrence's end; NULL = repeats forever
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    UNIQUE (owner_id, calendar_id, uid, recurrence_id),
    FOREIGN KEY (owner_id, calendar_id) REFERENCES calendars(owner_id, id) ON DELETE CASCADE
);
-- Calendar sync per connected account: when it last worked, and why not if it didn't.
CREATE TABLE IF NOT EXISTS calendar_accounts (
    owner_id        UUID NOT NULL REFERENCES users(id) DEFAULT NULLIF(current_setting('app.user_id', true), '')::uuid,
    connector_id    TEXT NOT NULL,
    last_synced_at  TIMESTAMPTZ,
    last_error      TEXT,
    PRIMARY KEY (owner_id, connector_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_range ON calendar_events(owner_id, starts_at, until_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON calendars, calendar_events, calendar_accounts TO missive_app;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['calendars','calendar_events','calendar_accounts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS owner_only ON %I', t);
    EXECUTE format(
      'CREATE POLICY owner_only ON %I USING (owner_id = NULLIF(current_setting(''app.user_id'', true), '''')::uuid) WITH CHECK (owner_id = NULLIF(current_setting(''app.user_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
