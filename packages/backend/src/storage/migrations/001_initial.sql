-- Missive Schema — PostgreSQL
-- Missive owns: raw communications, sync state, AI annotations, events.
-- Pathway owns: entities, relationships, graph, memory.
-- Extensions (pgcrypto, pg_trgm) are created by docker-entrypoint (000_ext.sql).

-- ── Connectors ──
CREATE TABLE connectors (
    id            TEXT PRIMARY KEY,
    provider      TEXT NOT NULL,
    label         TEXT NOT NULL,
    email         TEXT,
    enabled       BOOLEAN NOT NULL DEFAULT true,
    credentials   JSONB NOT NULL DEFAULT '{}',
    settings      JSONB NOT NULL DEFAULT '{}',
    last_sync_at  TIMESTAMPTZ,
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Threads ──
CREATE TABLE threads (
    id                TEXT PRIMARY KEY,
    provider          TEXT NOT NULL,
    provider_thread_id TEXT NOT NULL,
    subject           TEXT,
    participants      JSONB NOT NULL DEFAULT '[]',
    message_count     INTEGER NOT NULL DEFAULT 0,
    missive_ids       TEXT[] NOT NULL DEFAULT '{}',
    entity_ids        TEXT[] DEFAULT '{}',
    summary           TEXT,
    last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider, provider_thread_id)
);

CREATE INDEX idx_threads_provider ON threads(provider);
CREATE INDEX idx_threads_subject ON threads USING gin(subject gin_trgm_ops);
CREATE INDEX idx_threads_last_activity ON threads(last_activity_at DESC);

-- ── Missives ──
CREATE TABLE missives (
    id                  TEXT PRIMARY KEY,
    thread_id           TEXT NOT NULL REFERENCES threads(id),
    channel             TEXT NOT NULL,
    direction           TEXT NOT NULL,
    provider            TEXT NOT NULL,
    provider_message_id TEXT NOT NULL,
    subject             TEXT,
    body                TEXT NOT NULL,
    body_html           TEXT,
    summary             TEXT,
    sender_name         TEXT,
    sender_address      TEXT NOT NULL,
    recipients          JSONB NOT NULL DEFAULT '[]',
    cc                  JSONB DEFAULT '[]',
    bcc                 JSONB DEFAULT '[]',
    attachments         JSONB DEFAULT '[]',
    headers             JSONB DEFAULT '{}',
    status              TEXT NOT NULL DEFAULT 'unread',
    classification      TEXT,
    entity_ids          TEXT[] DEFAULT '{}',
    received_at         TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider, provider_message_id)
);

CREATE INDEX idx_missives_thread ON missives(thread_id);
CREATE INDEX idx_missives_provider ON missives(provider);
CREATE INDEX idx_missives_channel ON missives(channel);
CREATE INDEX idx_missives_status ON missives(status);
CREATE INDEX idx_missives_classification ON missives(classification);
CREATE INDEX idx_missives_sender ON missives(sender_address);
CREATE INDEX idx_missives_received ON missives(received_at DESC);
CREATE INDEX idx_missives_body ON missives USING gin(to_tsvector('english', body));
CREATE INDEX idx_missives_subject ON missives USING gin(to_tsvector('english', COALESCE(subject, '')));

-- ── Sync Log ──
CREATE TABLE sync_logs (
    id            TEXT PRIMARY KEY,
    connector_id  TEXT NOT NULL REFERENCES connectors(id),
    status        TEXT NOT NULL,
    new_count     INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    errors        JSONB DEFAULT '[]',
    started_at    TIMESTAMPTZ NOT NULL,
    finished_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Events (Pathway Integration) ──
CREATE TABLE events (
    id        TEXT PRIMARY KEY,
    type      TEXT NOT NULL,
    payload   JSONB NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_timestamp ON events(timestamp DESC);
