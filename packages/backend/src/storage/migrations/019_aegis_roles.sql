-- Admin rights come from Aegis, not a hard-coded list. At sign-in (scope
-- "admin") Aegis reports the person's roles in their tenant, the tenants
-- they manage, and whether they're a platform admin; Missive keeps the
-- latest of these here.
ALTER TABLE users ADD COLUMN IF NOT EXISTS aegis_tenant TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_tenants TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_admin BOOLEAN NOT NULL DEFAULT false;

-- Which Aegis tenant each Missive site's client belongs to (learned from
-- sign-ins: a login through a client always completes in that client's tenant).
CREATE TABLE IF NOT EXISTS aegis_client_tenants (
    client_id   TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
