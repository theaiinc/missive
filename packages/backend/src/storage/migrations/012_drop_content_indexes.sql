-- Mail content (subject, body, sender, account address) is now stored
-- encrypted, so full-text, trigram and equality indexes over those columns
-- index ciphertext: useless for search, and on the full-text ones Postgres
-- would tokenise the ciphertext. Search filters these in the app instead.
DROP INDEX IF EXISTS idx_threads_subject;
DROP INDEX IF EXISTS idx_missives_sender;
DROP INDEX IF EXISTS idx_missives_body;
DROP INDEX IF EXISTS idx_missives_subject;
DROP INDEX IF EXISTS idx_missives_account_email;
