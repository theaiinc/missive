-- The signature for each address someone sends from (Settings → Signatures,
-- compose, and AI drafts). Without a row, a connected Gmail account's
-- signature is read from Gmail (signature.service.ts). The text is encrypted
-- for its owner; the hash of the address keeps one row per address.
CREATE TABLE IF NOT EXISTS signatures (
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFAULT NULLIF(current_setting('app.user_id', true), '')::uuid,
    address_hash    TEXT NOT NULL,
    text            TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, address_hash)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON signatures TO missive_app;

ALTER TABLE signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE signatures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_only ON signatures;
CREATE POLICY owner_only ON signatures
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
