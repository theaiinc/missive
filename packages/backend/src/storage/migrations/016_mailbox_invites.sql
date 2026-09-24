-- Invitations to a specific hosted mailbox. An admin reserves an address
-- (say nhi.yen@bugmole.com) and gets a one-time link; whoever signs in
-- through it gets that mailbox. Only a hash of the link's token is kept.
-- The address is encrypted like mailboxes.address and indexed with the same
-- blind-index label, so a pending invite reserves the address.
CREATE TABLE mailbox_invites (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash    TEXT NOT NULL UNIQUE,
    address       TEXT NOT NULL,
    address_bidx  TEXT NOT NULL,
    domain        TEXT NOT NULL REFERENCES domains(name),
    display_name  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    claimed_at    TIMESTAMPTZ,
    claimed_by    UUID REFERENCES users(id)
);

-- One open invitation per address.
CREATE UNIQUE INDEX mailbox_invites_open_address ON mailbox_invites(address_bidx) WHERE claimed_at IS NULL;
