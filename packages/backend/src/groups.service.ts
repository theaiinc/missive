import { Injectable } from "@nestjs/common";
import { PostgresService } from "./storage/postgres.service";
import { addressIndex, normalizeAddress, openIdentity, sealIdentity } from "./identity-crypto";
import { UsersService, type Mailbox } from "./users.service";
import type { RequestUser } from "./request-context";

export type GroupRole = "owner" | "moderator" | "member";
export const GROUP_ROLES: GroupRole[] = ["owner", "moderator", "member"];
export type Group = { id: string; address: string; domain: string; name?: string; createdAt: string };
export type GroupMember = { userId: string; email: string; name?: string; role: GroupRole; mailboxes: string[] };

/** An address someone has: their own mailbox, or a group they belong to (role says whether they may send as it). */
export type SendAddress = Mailbox & { kind: "mailbox" | "group"; role?: GroupRole };

const rowToGroup = async (r: any): Promise<Group> => ({
  id: r.id,
  address: (await openIdentity("mail_groups.address", r.address))!,
  domain: r.domain,
  name: r.name ?? undefined,
  createdAt: new Date(r.created_at).toISOString(),
});

/**
 * Email groups. Like users and mailboxes these rows sit outside row-level
 * security (systemQuery); group management is only reachable by admins
 * (AdminController), and delivery is driven by a verified inbound address.
 */
@Injectable()
export class GroupsService {
  constructor(
    private readonly pg: PostgresService,
    private readonly users: UsersService,
  ) {}

  async list(): Promise<Group[]> {
    const { rows } = await this.pg.systemQuery(`SELECT * FROM mail_groups`);
    return (await Promise.all(rows.map(rowToGroup))).sort((a, b) => a.address.localeCompare(b.address));
  }

  async byAddress(address: string): Promise<Group | null> {
    const { rows } = await this.pg.systemQuery(`SELECT * FROM mail_groups WHERE address_bidx = $1`, [
      await addressIndex("mailboxes.address", normalizeAddress(address)),
    ]);
    return rows[0] ? rowToGroup(rows[0]) : null;
  }

  /** Creates a group at a hosted domain. Null if the address is already a mailbox, group or invitation. */
  async create(address: string, name: string | undefined, createdBy: string): Promise<Group | null> {
    const lower = normalizeAddress(address);
    const domain = lower.split("@")[1] ?? "";
    const hosted = await this.pg.systemQuery(`SELECT 1 FROM domains WHERE name = $1`, [domain]);
    if (!hosted.rows.length || (await this.users.addressTaken(lower))) return null;
    const { rows } = await this.pg.systemQuery(
      `INSERT INTO mail_groups (address, address_bidx, domain, name, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (address_bidx) DO NOTHING
       RETURNING *`,
      [await sealIdentity("mail_groups.address", lower), await addressIndex("mailboxes.address", lower), domain, name ?? null, createdBy],
    );
    return rows[0] ? rowToGroup(rows[0]) : null;
  }

  async rename(groupId: string, name: string | undefined): Promise<boolean> {
    const { rowCount } = await this.pg.systemQuery(`UPDATE mail_groups SET name = $2 WHERE id = $1`, [groupId, name ?? null]);
    return (rowCount ?? 0) > 0;
  }

  async remove(groupId: string): Promise<boolean> {
    const { rowCount } = await this.pg.systemQuery(`DELETE FROM mail_groups WHERE id = $1`, [groupId]);
    return (rowCount ?? 0) > 0;
  }

  async members(groupId: string): Promise<GroupMember[]> {
    const { rows } = await this.pg.systemQuery(
      `SELECT m.user_id, m.role, u.email, u.name FROM mail_group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = $1`,
      [groupId],
    );
    const order: Record<string, number> = { owner: 0, moderator: 1, member: 2 };
    const members = await Promise.all(
      rows.map(async (r: any): Promise<GroupMember> => ({
        userId: r.user_id,
        role: r.role,
        email: (await openIdentity("users.email", r.email))!,
        name: (await openIdentity("users.name", r.name)) ?? undefined,
        mailboxes: (await this.users.mailboxesOf(r.user_id)).map((b) => b.address),
      })),
    );
    return members.sort((a, b) => order[a.role]! - order[b.role]! || a.email.localeCompare(b.email));
  }

  /** Adds someone, or changes their role. */
  async setMember(groupId: string, userId: string, role: GroupRole): Promise<void> {
    await this.pg.systemQuery(
      `INSERT INTO mail_group_members (group_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (group_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [groupId, userId, role],
    );
  }

  async removeMember(groupId: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.pg.systemQuery(`DELETE FROM mail_group_members WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);
    return (rowCount ?? 0) > 0;
  }

  /** Everyone who receives the group's mail. */
  async recipients(groupId: string): Promise<RequestUser[]> {
    const { rows } = await this.pg.systemQuery(`SELECT user_id FROM mail_group_members WHERE group_id = $1`, [groupId]);
    const users = await Promise.all(rows.map((r: any) => this.users.byId(r.user_id)));
    return users.filter((u): u is RequestUser => !!u);
  }

  /**
   * The person's own mailboxes, then every group they're in (with their role).
   * Only owners and moderators may send as a group (see MailboxService.send).
   */
  async addressesOf(userId: string): Promise<SendAddress[]> {
    const own: SendAddress[] = (await this.users.mailboxesOf(userId)).map((m) => ({ ...m, kind: "mailbox" }));
    const { rows } = await this.pg.systemQuery(
      `SELECT g.*, m.role FROM mail_group_members m JOIN mail_groups g ON g.id = m.group_id WHERE m.user_id = $1`,
      [userId],
    );
    const groups: SendAddress[] = await Promise.all(
      rows.map(async (r: any): Promise<SendAddress> => {
        const g = await rowToGroup(r);
        return { address: g.address, domain: g.domain, userId, displayName: g.name, kind: "group", role: r.role };
      }),
    );
    return [...own, ...groups.sort((a, b) => a.address.localeCompare(b.address))];
  }
}
