import { Injectable } from "@nestjs/common";
import { PostgresService } from "./storage/postgres.service";
import type { RequestUser } from "./request-context";
import { addressIndex, normalizeAddress, openIdentity, sealIdentity } from "./identity-crypto";

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
}
