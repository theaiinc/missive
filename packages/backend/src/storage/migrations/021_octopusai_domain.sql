-- Missive hosts octopusai.live too (Email Routing's catch-all sends its mail
-- to the missive Worker), so it can hold mailboxes and groups.
INSERT INTO domains (name) VALUES ('octopusai.live') ON CONFLICT (name) DO NOTHING;
