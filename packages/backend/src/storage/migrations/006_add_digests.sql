-- ── Digests ──
-- AI-generated summary of recent missives
CREATE TABLE digests (
    id              TEXT PRIMARY KEY,
    summary         TEXT NOT NULL,
    items           JSONB NOT NULL DEFAULT '[]',
    period_start    TIMESTAMPTZ NOT NULL,
    period_end      TIMESTAMPTZ NOT NULL,
    missive_count   INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_digests_created ON digests(created_at DESC);
