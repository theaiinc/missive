-- Drafts are stored encrypted (draft-crypto.ts): payload becomes a JSON string
-- holding the ciphertext, and mailbox ciphertext text. is_empty records, at
-- write time, whether the draft holds nothing (isEmptyDraftPayload), so the
-- empty-draft cleanup needn't read the content. NULL: a row from before this,
-- which the cleanup still judges from its plain payload until
-- scripts/encrypt-drafts.ts rewrites it.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS is_empty BOOLEAN;
