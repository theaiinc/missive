-- Missive hosts bugmole.com mailboxes: mail.bugmole.com signs in with the
-- Bugmole tenant, whose accounts Aegis offers a bugmole.com mailbox
-- (mailbox_domain). An offer only counts for a domain listed here.
INSERT INTO domains (name) VALUES ('bugmole.com') ON CONFLICT (name) DO NOTHING;
