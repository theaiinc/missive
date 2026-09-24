-- A thread or message is unique per owner, not across everyone. The same
-- email reaching two people (a group's members, or two Missive mailboxes on
-- one email) gives each their own copy, which the global keys refused.
ALTER TABLE threads DROP CONSTRAINT IF EXISTS threads_provider_provider_thread_id_key;
ALTER TABLE threads ADD CONSTRAINT threads_owner_provider_thread_key UNIQUE (owner_id, provider, provider_thread_id);

ALTER TABLE missives DROP CONSTRAINT IF EXISTS missives_provider_provider_message_id_key;
ALTER TABLE missives ADD CONSTRAINT missives_owner_provider_message_key UNIQUE (owner_id, provider, provider_message_id);
