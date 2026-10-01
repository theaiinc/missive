-- When a person last filed a message themselves (moved it, marked it spam or
-- not spam). The organizer leaves those where they put them, instead of
-- classifying them again and moving them back.
ALTER TABLE missives ADD COLUMN IF NOT EXISTS filed_by_user_at TIMESTAMPTZ;
