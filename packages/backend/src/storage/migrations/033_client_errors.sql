-- Errors the web app hit in someone's browser or the Mac app (a screen that
-- failed to render, an uncaught error), so a page that breaks can be fixed
-- without a screenshot. Only the error text, stack, page path and browser;
-- never mail content. Kept per user like everything else.
CREATE TABLE IF NOT EXISTS client_errors (
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFAULT NULLIF(current_setting('app.user_id', true), '')::uuid,
    kind            TEXT NOT NULL,
    message         TEXT NOT NULL,
    stack           TEXT,
    component_stack TEXT,
    page            TEXT,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, id)
);
CREATE INDEX IF NOT EXISTS client_errors_recent ON client_errors (created_at DESC);

GRANT SELECT, INSERT, DELETE ON client_errors TO missive_app;

ALTER TABLE client_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_errors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_only ON client_errors;
CREATE POLICY owner_only ON client_errors
  USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
