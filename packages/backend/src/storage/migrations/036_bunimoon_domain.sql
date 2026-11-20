-- Missive hosts bunimoon.com too (Email Routing's catch-all sends its mail
-- to the missive Worker), so it can hold mailboxes and groups.
INSERT INTO domains (name) VALUES ('bunimoon.com') ON CONFLICT (name) DO NOTHING;
