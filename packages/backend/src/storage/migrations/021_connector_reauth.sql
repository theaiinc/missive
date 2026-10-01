-- A connector whose refresh token the provider has refused (revoked, expired
-- or already rotated) is marked status = 'needs_reauth' with the reason here,
-- and is not synced again until the person reconnects it.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS last_error TEXT;
