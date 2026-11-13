-- Chat apps that call Missive (WeCom, Zalo Official Account) post to
-- /api/v1/hooks/<provider>/<key>. The key is random and secret; only its
-- SHA-256 is kept here, mapped to the connector and its owner, so a webhook
-- call can be filed as that person without a session. Each call is then
-- verified with the connector's own signing secret.
CREATE TABLE IF NOT EXISTS chat_webhooks (
    key_hash     TEXT PRIMARY KEY,
    owner_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFAULT NULLIF(current_setting('app.user_id', true), '')::uuid,
    connector_id TEXT NOT NULL,
    provider     TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_webhooks_connector ON chat_webhooks (owner_id, connector_id);

GRANT SELECT, INSERT, DELETE ON chat_webhooks TO missive_app;

-- Row-level security binds missive_app (requests) to its owner's rows. It is
-- not FORCEd: the lookup by key (PostgresService.systemQuery) has no user yet.

ALTER TABLE chat_webhooks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_only ON chat_webhooks;
CREATE POLICY owner_only ON chat_webhooks
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
