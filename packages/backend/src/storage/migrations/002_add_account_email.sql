-- Add account_email to missives so each message knows which connected account it came from
ALTER TABLE missives ADD COLUMN IF NOT EXISTS account_email TEXT;
CREATE INDEX IF NOT EXISTS idx_missives_account_email ON missives(account_email);
