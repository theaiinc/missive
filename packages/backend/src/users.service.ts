import { Injectable } from "@nestjs/common";
import { PostgresService } from "./storage/postgres.service";
import type { RequestUser } from "./request-context";

export type Mailbox = { address: string; domain: string; userId: string; displayName?: string };

const rowToMailbox = (r: any): Mailbox => ({
  address: r.address,
  domain: r.domain,
  userId: r.user_id,
  displayName: r.display_name ?? undefined,
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
    const lower = email.toLowerCase();
    const { rows } = await this.pg.systemQuery(
      `INSERT INTO users (email, aegis_sub, name, last_login_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (email) DO UPDATE SET
         aegis_sub = COALESCE(users.aegis_sub, EXCLUDED.aegis_sub),
         name = COALESCE(EXCLUDED.name, users.name),
         last_login_at = NOW()
       RETURNING id, email, aegis_sub, name`,
      [lower, sub, name ?? null]
    );
    const user = rows[0];
    // The email was claimed by a different Aegis account: refuse rather than merge.
    if (user.aegis_sub !== sub) throw new Error("This email belongs to another account");
    await this.pg.ensureUserFolders(user.id);
    return { id: user.id, email: user.email, name: user.name ?? undefined };
  }

  async byId(id: string): Promise<RequestUser | null> {
    const { rows } = await this.pg.systemQuery(`SELECT id, email, name FROM users WHERE id = $1`, [id]);
    return rows[0] ? { id: rows[0].id, email: rows[0].email, name: rows[0].name ?? undefined } : null;
  }

  /** Everyone, for background jobs that run once per user. */
  async all(): Promise<RequestUser[]> {
    const { rows } = await this.pg.systemQuery(`SELECT id, email, name FROM users ORDER BY created_at`);
    return rows.map((r: any) => ({ id: r.id, email: r.email, name: r.name ?? undefined }));
  }

  async mailboxesOf(userId: string): Promise<Mailbox[]> {
    const { rows } = await this.pg.systemQuery(`SELECT * FROM mailboxes WHERE user_id = $1 ORDER BY address`, [userId]);
    return rows.map(rowToMailbox);
  }

  async mailbox(address: string): Promise<Mailbox | null> {
    const { rows } = await this.pg.systemQuery(`SELECT * FROM mailboxes WHERE address = $1`, [address.toLowerCase()]);
    return rows[0] ? rowToMailbox(rows[0]) : null;
  }
}
