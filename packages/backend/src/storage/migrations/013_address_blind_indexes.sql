-- Addresses used as lookup keys are now stored encrypted in their own columns
-- (users.email, mailboxes.address, connectors.email) and looked up through a
-- keyed hash (blind index) instead. Ciphertext is still unique and non-null,
-- so the existing UNIQUE / PRIMARY KEY constraints keep working.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_bidx TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_bidx_key ON users(email_bidx);

ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS address_bidx TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_address_bidx_key ON mailboxes(address_bidx);

-- The CHECKs (lower-case address; domain = the address's domain) can't be
-- evaluated on ciphertext; the app normalises addresses before storing them.
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'mailboxes'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE mailboxes DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
