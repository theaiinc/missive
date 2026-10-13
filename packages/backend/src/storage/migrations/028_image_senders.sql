-- Senders whose images someone chose to always show ("Always show images
-- from …"). Remote images are hidden otherwise (images.ts). Only a hash of
-- the address is kept: enough to answer "is this sender trusted?".
CREATE TABLE IF NOT EXISTS image_senders (
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFAULT NULLIF(current_setting('app.user_id', true), '')::uuid,
    address_hash    TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, address_hash)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON image_senders TO missive_app;

ALTER TABLE image_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE image_senders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_only ON image_senders;
CREATE POLICY owner_only ON image_senders
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
