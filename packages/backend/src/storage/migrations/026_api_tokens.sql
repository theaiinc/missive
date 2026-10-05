-- Personal API tokens: another app (Simasis) calls the API on a user's behalf
-- with `Authorization: Bearer msv_...` (see auth/api-tokens.ts). Only the
-- SHA-256 of the token is kept; `prefix` is a few characters of it to tell
-- tokens apart in the settings page.
--
-- The owner lists, creates and revokes their tokens as missive_app, so the
-- usual owner_only policy applies. Row-level security is enabled but NOT
-- forced: the sign-in check looks a token up by its hash before anyone is
-- signed in, through systemQuery (the owner role, like users and
-- mailbox_invites), and that lookup must see every row.
CREATE TABLE IF NOT EXISTS api_tokens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFAULT NULLIF(current_setting('app.user_id', true), '')::uuid,
    name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    token_hash    TEXT NOT NULL UNIQUE,
    prefix        TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at  TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

GRANT SELECT, INSERT, UPDATE ON api_tokens TO missive_app;

ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_only ON api_tokens;
CREATE POLICY owner_only ON api_tokens
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
