-- When the organizer labelled a message but left it where one of your rules
-- puts it, so its clean-up passes don't pick it up again on every run.
ALTER TABLE missives ADD COLUMN IF NOT EXISTS ruled_at TIMESTAMPTZ;
