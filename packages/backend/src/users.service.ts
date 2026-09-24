import { Injectable } from "@nestjs/common";
import { PostgresService } from "./storage/postgres.service";
import type { RequestUser } from "./request-context";
import { createHash, randomBytes } from "node:crypto";
import { addressIndex, normalizeAddress, openIdentity, sealIdentity } from "./identity-crypto";
import { runAsUser } from "./request-context";

/** Only a hash of an invitation link's token is stored. */
const inviteHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** The admin claims Aegis sends with scope "admin". */
export type AegisRoleClaims = { roles?: unknown; role?: unknown; home_tenant_id?: unknown; managed_tenant_ids?: unknown; platform_admin?: unknown };
export type AdminScope = { platform: boolean; tenants: string[] };

export type Mailbox = { address: string; domain: string; userId: string; displayName?: string };

const rowToMailbox = async (r: any): Promise<Mailbox> => ({
  address: (await openIdentity("mailboxes.address", r.address))!,
  domain: r.domain,
  userId: r.user_id,
  displayName: (await openIdentity("mailboxes.display_name", r.display_name)) ?? undefined,
});

const rowToUser = async (r: any): Promise<RequestUser> => ({
  id: r.id,
  email: (await openIdentity("users.email", r.email))!,
  name: (await openIdentity("users.name", r.name)) ?? undefined,
});

/**
 * Users (Aegis identities) and the hosted mailboxes they own. These tables
 * sit outside row-level security, so everything here uses systemQuery and
 * must only be driven by verified identity or a verified inbound address.
 */
@Injectable()
export class UsersService {
  constructor(private readonly pg: PostgresService) {}

  /**
   * Called after Aegis verifies someone. Matches the Aegis subject first,
   * then a not-yet-claimed user with the same verified email (created with a
   * mailbox before their first sign-in), and otherwise creates the user.
   */
  async signIn(sub: string, email: string, name?: string): Promise<RequestUser> {
    const lower = normalizeAddress(email);
    // Matched on the email's blind index; email and name are stored encrypted.
    const { rows } = await this.pg.systemQuery(
      `INSERT INTO users (email, email_bidx, aegis_sub, name, last_login_at) VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (email_bidx) DO UPDATE SET
         aegis_sub = COALESCE(users.aegis_sub, EXCLUDED.aegis_sub),
         name = COALESCE(EXCLUDED.name, users.name),
         last_login_at = NOW()
       RETURNING id, email, aegis_sub, name`,
      [await sealIdentity("users.email", lower), await addressIndex("users.email", lower), sub, await sealIdentity("users.name", name)]
    );
    const user = rows[0];
    // The email was claimed by a different Aegis account: refuse rather than merge.
    if (user.aegis_sub !== sub) throw new Error("This email belongs to another account");
    await this.pg.ensureUserFolders(user.id);
    return rowToUser(user);
  }

  async byId(id: string): Promise<RequestUser | null> {
    const { rows } = await this.pg.systemQuery(`SELECT id, email, name FROM users WHERE id = $1`, [id]);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  /**
   * Records what Aegis said at sign-in: the client (organization) and tenant
   * they came in through, and their admin rights. An ADMIN in their own
   * tenant administers it; tenants they manage in Aegis count too.
   */
  async recordSignIn(userId: string, clientId: string, claims: AegisRoleClaims): Promise<void> {
    const home = typeof claims.home_tenant_id === "string" ? claims.home_tenant_id : null;
    const roles = Array.isArray(claims.roles) ? claims.roles.map(String) : typeof claims.role === "string" ? [claims.role] : [];
    const managed = Array.isArray(claims.managed_tenant_ids) ? claims.managed_tenant_ids.map(String) : [];
    const adminTenants = [...new Set([...(home && roles.includes("ADMIN") ? [home] : []), ...managed])];
    await this.pg.systemQuery(
      `UPDATE users SET aegis_client = $2, aegis_tenant = $3, admin_tenants = $4, platform_admin = $5 WHERE id = $1`,
      [userId, clientId, home, adminTenants, claims.platform_admin === true],
    );
    if (home) {
      await this.pg.systemQuery(
        `INSERT INTO aegis_client_tenants (client_id, tenant_id) VALUES ($1, $2)
         ON CONFLICT (client_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, seen_at = NOW()`,
        [clientId, home],
      );
    }
  }

  /** What someone may administer: every tenant (platform admin), some, or nothing (null). */
  async adminScope(userId: string): Promise<AdminScope | null> {
    const { rows } = await this.pg.systemQuery(`SELECT admin_tenants, platform_admin FROM users WHERE id = $1`, [userId]);
    const r = rows[0];
    if (!r || (!r.platform_admin && !(r.admin_tenants ?? []).length)) return null;
    return { platform: !!r.platform_admin, tenants: r.admin_tenants ?? [] };
  }

  /** The Aegis tenant each client signs in to, as learned from sign-ins. */
  async clientTenants(): Promise<Record<string, string>> {
    const { rows } = await this.pg.systemQuery(`SELECT client_id, tenant_id FROM aegis_client_tenants`);
    return Object.fromEntries(rows.map((r: any) => [r.client_id, r.tenant_id]));
  }

  /** Everyone, for the admin console: who they are, their organization, and their mailboxes. */
  async directory(): Promise<{ id: string; email: string; name?: string; client: string | null; tenant: string | null; signedIn: boolean; lastLoginAt: string | null; mailboxes: string[] }[]> {
    const { rows } = await this.pg.systemQuery(`SELECT id, email, name, aegis_client, aegis_tenant, aegis_sub, last_login_at FROM users`);
    const people = await Promise.all(
      rows.map(async (r: any) => ({
        id: r.id,
        email: (await openIdentity("users.email", r.email))!,
        name: (await openIdentity("users.name", r.name)) ?? undefined,
        client: r.aegis_client ?? null,
        tenant: r.aegis_tenant ?? null,
        signedIn: !!r.aegis_sub,
        lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
        mailboxes: (await this.mailboxesOf(r.id)).map((m) => m.address),
      })),
    );
    return people.sort((a, b) => a.email.localeCompare(b.email));
  }

  /** Everyone, for background jobs that run once per user. */
  async all(): Promise<RequestUser[]> {
    const { rows } = await this.pg.systemQuery(`SELECT id, email, name FROM users ORDER BY created_at`);
    return Promise.all(rows.map(rowToUser));
  }

  async mailboxesOf(userId: string): Promise<Mailbox[]> {
    const { rows } = await this.pg.systemQuery(`SELECT * FROM mailboxes WHERE user_id = $1`, [userId]);
    // Addresses are encrypted, so they are sorted here rather than in SQL.
    return (await Promise.all(rows.map(rowToMailbox))).sort((a, b) => a.address.localeCompare(b.address));
  }

  async mailbox(address: string): Promise<Mailbox | null> {
    // By blind index; a mailbox inserted by hand in plaintext is still found
    // until the next startup encrypts it.
    const lower = normalizeAddress(address);
    const { rows } = await this.pg.systemQuery(
      `SELECT * FROM mailboxes WHERE address_bidx = $1 OR (address_bidx IS NULL AND address = $2)`,
      [await addressIndex("mailboxes.address", lower), lower],
    );
    return rows[0] ? rowToMailbox(rows[0]) : null;
  }

  // ── Hosted mailbox offer (Aegis claim mailbox_domain) ──

  /** Records (or clears) the domain Aegis offered at this sign-in. */
  async setMailboxOffer(userId: string, domain: string | null): Promise<void> {
    await this.pg.systemQuery(`UPDATE users SET mailbox_offer_domain = $2 WHERE id = $1`, [userId, domain]);
  }

  /**
   * The domain this person may claim a mailbox at, or null. Only while they
   * have no hosted mailbox and no connected Gmail/Outlook/IMAP account, and
   * only for a domain Missive actually hosts.
   */
  async mailboxOffer(userId: string): Promise<string | null> {
    const { rows } = await this.pg.systemQuery(
      `SELECT u.mailbox_offer_domain AS domain
         FROM users u JOIN domains d ON d.name = u.mailbox_offer_domain
        WHERE u.id = $1 AND NOT EXISTS (SELECT 1 FROM mailboxes m WHERE m.user_id = u.id)`,
      [userId],
    );
    const domain: string | undefined = rows[0]?.domain;
    if (!domain) return null;
    const connected = await runAsUser({ id: userId, email: "" }, () => this.pg.query(`SELECT 1 FROM connectors LIMIT 1`));
    return connected.rows.length ? null : domain;
  }

  /** Taken by a mailbox or a group, or reserved by an open invitation. */
  async addressTaken(address: string): Promise<boolean> {
    const { rows } = await this.pg.systemQuery(
      `SELECT 1 FROM mailboxes WHERE address_bidx = $1
       UNION ALL
       SELECT 1 FROM mail_groups WHERE address_bidx = $1
       UNION ALL
       SELECT 1 FROM mailbox_invites WHERE address_bidx = $1 AND claimed_at IS NULL AND expires_at > NOW()`,
      [await addressIndex("mailboxes.address", address)],
    );
    return rows.length > 0;
  }

  /** Creates the hosted mailbox (address stored encrypted) and clears the offer. Null if the address was just taken. */
  async createMailbox(userId: string, address: string, domain: string, displayName?: string): Promise<Mailbox | null> {
    const lower = normalizeAddress(address);
    // A group owns this address.
    const group = await this.pg.systemQuery(`SELECT 1 FROM mail_groups WHERE address_bidx = $1`, [await addressIndex("mailboxes.address", lower)]);
    if (group.rows.length) return null;
    const { rows } = await this.pg.systemQuery(
      `INSERT INTO mailboxes (address, address_bidx, domain, user_id, display_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (address_bidx) DO NOTHING
       RETURNING *`,
      [await sealIdentity("mailboxes.address", lower), await addressIndex("mailboxes.address", lower), domain, userId,
       await sealIdentity("mailboxes.display_name", displayName)],
    );
    if (!rows[0]) return null;
    await this.setMailboxOffer(userId, null);
    return rowToMailbox(rows[0]);
  }

  /**
   * An account whose verified email is itself an address on a domain Missive
   * hosts (an admin provisioned nhi.yen@bugmole.com in Aegis) gets that
   * mailbox on sign-in. Only while the address is free (no mailbox, no open
   * invitation) and the person has no hosted mailbox yet. Verification is
   * what makes this safe: mail to an unclaimed hosted address doesn't reach
   * whoever asks for it, so only an admin can vouch for one.
   */
  async provisionOwnAddress(userId: string, email: string, name?: string): Promise<Mailbox | null> {
    const address = normalizeAddress(email);
    const domain = address.split("@")[1] ?? "";
    const hosted = await this.pg.systemQuery(`SELECT 1 FROM domains WHERE name = $1`, [domain]);
    if (!hosted.rows.length) return null;
    if ((await this.mailboxesOf(userId)).length || (await this.addressTaken(address))) return null;
    return this.createMailbox(userId, address, domain, name);
  }

  // ── Mailbox invitations (a link for one specific address) ──

  /**
   * Reserves `address` and returns the one-time token for its link. An open
   * invitation for the same address is replaced, so a lost link can be
   * reissued. Null when the address already has a mailbox or its domain
   * isn't hosted.
   */
  async createInvite(address: string, displayName: string | undefined, days: number): Promise<{ token: string; expiresAt: Date } | null> {
    const lower = normalizeAddress(address);
    const domain = lower.split("@")[1] ?? "";
    const bidx = await addressIndex("mailboxes.address", lower);
    const hosted = await this.pg.systemQuery(`SELECT 1 FROM domains WHERE name = $1`, [domain]);
    const owned = await this.pg.systemQuery(`SELECT 1 FROM mailboxes WHERE address_bidx = $1`, [bidx]);
    if (!hosted.rows.length || owned.rows.length) return null;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    const client = await this.pg.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM mailbox_invites WHERE address_bidx = $1 AND claimed_at IS NULL`, [bidx]);
      await client.query(
        `INSERT INTO mailbox_invites (token_hash, address, address_bidx, domain, display_name, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [inviteHash(token), await sealIdentity("mailbox_invites.address", lower), bidx, domain,
         await sealIdentity("mailbox_invites.display_name", displayName), expiresAt],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return { token, expiresAt };
  }

  /** The address an open, unexpired invitation is for, or null. */
  async openInvite(token: string): Promise<string | null> {
    const { rows } = await this.pg.systemQuery(
      `SELECT address FROM mailbox_invites WHERE token_hash = $1 AND claimed_at IS NULL AND expires_at > NOW()`,
      [inviteHash(token)],
    );
    return rows[0] ? openIdentity("mailbox_invites.address", rows[0].address) : null;
  }

  /**
   * Gives the invitation's mailbox to `userId` and closes the invitation, in
   * one transaction so a link works once. Null if the link is no longer open
   * or this person already has a hosted mailbox.
   */
  async claimInvite(token: string, userId: string): Promise<Mailbox | null> {
    const client = await this.pg.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT * FROM mailbox_invites WHERE token_hash = $1 AND claimed_at IS NULL AND expires_at > NOW() FOR UPDATE`,
        [inviteHash(token)],
      );
      const invite = rows[0];
      const has = await client.query(`SELECT 1 FROM mailboxes WHERE user_id = $1`, [userId]);
      if (!invite || has.rows.length) {
        await client.query("ROLLBACK");
        return null;
      }
      const address = (await openIdentity("mailbox_invites.address", invite.address))!;
      const displayName = (await openIdentity("mailbox_invites.display_name", invite.display_name)) ?? undefined;
      const created = await client.query(
        `INSERT INTO mailboxes (address, address_bidx, domain, user_id, display_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (address_bidx) DO NOTHING
         RETURNING *`,
        [await sealIdentity("mailboxes.address", address), invite.address_bidx, invite.domain, userId,
         await sealIdentity("mailboxes.display_name", displayName)],
      );
      if (!created.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(`UPDATE mailbox_invites SET claimed_at = NOW(), claimed_by = $2 WHERE id = $1`, [invite.id, userId]);
      await client.query(`UPDATE users SET mailbox_offer_domain = NULL WHERE id = $1`, [userId]);
      await client.query("COMMIT");
      return rowToMailbox(created.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
