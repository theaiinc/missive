-- Cc and (on your own sent mail) Bcc, as encrypted JSON text like reply_to.
-- New columns rather than the old unused cc/bcc JSONB ones: those default to
-- '[]' on every row, and encrypting them would rewrite every message.
ALTER TABLE missives ADD COLUMN IF NOT EXISTS cc_list TEXT;
ALTER TABLE missives ADD COLUMN IF NOT EXISTS bcc_list TEXT;
