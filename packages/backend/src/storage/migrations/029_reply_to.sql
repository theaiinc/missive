-- A message's Reply-To addresses (encrypted JSON, like recipients): replies go
-- there instead of to the sender, e.g. for mail relayed through a group.
ALTER TABLE missives ADD COLUMN IF NOT EXISTS reply_to TEXT;
