-- Browsers (and installed apps) that get a push notification when new mail
-- arrives, even with Missive closed (Web Push; see push.service.ts). The
-- subscription (endpoint and keys) is encrypted for its owner; the hash of
-- the endpoint keeps one row per browser.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFAULT NULLIF(current_setting('app.user_id', true), '')::uuid,
    endpoint_hash   TEXT NOT NULL,
    subscription    TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id),
    UNIQUE (owner_id, endpoint_hash)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO missive_app;

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_only ON push_subscriptions;
CREATE POLICY owner_only ON push_subscriptions
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
