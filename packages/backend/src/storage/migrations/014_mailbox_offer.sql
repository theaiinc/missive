-- The domain Aegis offers this user a hosted mailbox at (claim
-- mailbox_domain: a blank account in a tenant that provisions Missive
-- mailboxes). A domain, not an address. Cleared once they have a mailbox.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mailbox_offer_domain TEXT;
