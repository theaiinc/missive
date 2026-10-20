-- Files attached to messages, kept when the message is synced or received so
-- they can be opened in Missive (attachments.controller.ts). The file name and
-- the content (base64) are encrypted for the owner like other mail content;
-- type and size are kept plain to list them without decrypting.
CREATE TABLE IF NOT EXISTS attachments (
    id              TEXT NOT NULL,
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFAULT NULLIF(current_setting('app.user_id', true), '')::uuid,
    missive_id      TEXT NOT NULL,
    filename        TEXT NOT NULL,
    mime_type       TEXT NOT NULL,
    size            INTEGER NOT NULL,
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS attachments_missive ON attachments (owner_id, missive_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON attachments TO missive_app;

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_only ON attachments;
CREATE POLICY owner_only ON attachments
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- Mail synced before attachments were kept gets its files once per account
-- (SyncService.backfillAttachments); this marks the accounts that are done.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS attachments_backfilled_at TIMESTAMPTZ;
