-- Hosted, multi-user Missive.
--
-- People sign in with Aegis ID. Every row of mail data belongs to one user,
-- and Postgres enforces it: each request runs as the restricted missive_app
-- role with app.user_id set (see PostgresService), and row-level security
-- only shows that user's rows. New rows pick up the owner automatically.

-- ── Users (Aegis identities) ──
-- A user can exist before their first sign-in (a mailbox is created for them
-- first); aegis_sub is bound on the first sign-in with the verified email.
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT NOT NULL UNIQUE,
    aegis_sub   TEXT UNIQUE,
    name        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

-- ── Custom domains whose mail Missive hosts ──
CREATE TABLE domains (
    name        TEXT PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Hosted mailboxes (address@custom-domain) ──
CREATE TABLE mailboxes (
    address       TEXT PRIMARY KEY,
    domain        TEXT NOT NULL REFERENCES domains(name),
    user_id       UUID NOT NULL REFERENCES users(id),
    display_name  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (address = lower(address)),
    CHECK (split_part(address, '@', 2) = domain)
);
CREATE INDEX idx_mailboxes_user ON mailboxes(user_id);

-- ── Owner on every mail table ──
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['connectors','threads','missives','sync_logs','events','folders','rules','digests'] LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN owner_id UUID REFERENCES users(id) DEFAULT NULLIF(current_setting(''app.user_id'', true), '''')::uuid',
      t);
    EXECUTE format('CREATE INDEX idx_%s_owner ON %I(owner_id)', t, t);
  END LOOP;
END $$;

-- Folder ids and slugs are per user now (every user gets inbox, archived, …).
ALTER TABLE folders DROP CONSTRAINT folders_pkey;
ALTER TABLE folders DROP CONSTRAINT folders_slug_key;
ALTER TABLE folders ADD PRIMARY KEY (owner_id, id);
ALTER TABLE folders ADD CONSTRAINT folders_owner_slug_key UNIQUE (owner_id, slug);

-- ── The role requests run as ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'missive_app') THEN
    CREATE ROLE missive_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT missive_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO missive_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON connectors, threads, missives, sync_logs, events, folders, rules, digests TO missive_app;
-- Users and mailboxes are read to know who owns what; only the server's own
-- (owner-role) code creates or changes them.
GRANT SELECT ON users, mailboxes, domains TO missive_app;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['connectors','threads','missives','sync_logs','events','folders','rules','digests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_only ON %I USING (owner_id = NULLIF(current_setting(''app.user_id'', true), '''')::uuid) WITH CHECK (owner_id = NULLIF(current_setting(''app.user_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- Mail from before hosting has no owner and stays invisible until claimed:
--   UPDATE <table> SET owner_id = '<user id>' WHERE owner_id IS NULL;
