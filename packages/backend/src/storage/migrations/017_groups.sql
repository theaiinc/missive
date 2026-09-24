-- Email groups (like hello@bugmole.com), managed in the admin console.
-- Mail to a group is delivered into every member's own Missive inbox;
-- owners and moderators can also send as the group.
--
-- The address is encrypted and blind-indexed with the same label as
-- mailboxes.address, so one address is either a mailbox or a group.
CREATE TABLE mail_groups (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    address       TEXT NOT NULL,
    address_bidx  TEXT NOT NULL UNIQUE,
    domain        TEXT NOT NULL REFERENCES domains(name),
    name          TEXT,
    created_by    UUID REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE mail_group_members (
    group_id    UUID NOT NULL REFERENCES mail_groups(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('owner', 'moderator', 'member')),
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_mail_group_members_user ON mail_group_members(user_id);

-- The Aegis client (and so tenant / organization) a person last signed in through.
ALTER TABLE users ADD COLUMN IF NOT EXISTS aegis_client TEXT;
