CREATE TABLE folders (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    icon       TEXT,
    color      TEXT,
    system     BOOLEAN NOT NULL DEFAULT false,
    ord        INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE missives ADD COLUMN IF NOT EXISTS folder TEXT NOT NULL DEFAULT 'inbox';
CREATE INDEX IF NOT EXISTS idx_missives_folder ON missives(folder);
