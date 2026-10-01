-- Other addresses an account signs in with. An admin links someone's own
-- address (their Gmail) to their Missive account, so signing in to Aegis with
-- it opens that account and its professional mailbox. Bound to the Aegis
-- subject on first use, like users.aegis_sub. Outside row-level security
-- (systemQuery), like users; the email is encrypted and blind-indexed with
-- the same label as users.email, so one address is either an account or a link.
CREATE TABLE IF NOT EXISTS user_logins (
    email_bidx  TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    aegis_sub   TEXT UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_logins_user ON user_logins(user_id);
