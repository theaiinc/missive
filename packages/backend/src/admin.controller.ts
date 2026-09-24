import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Put } from "@nestjs/common";
import { requireUser } from "./request-context";
import { PostgresService } from "./storage/postgres.service";
import { UsersService } from "./users.service";
import { GROUP_ROLES, GroupsService, type GroupRole } from "./groups.service";
import { localPartProblem } from "./mailbox-claim";
import { extraSites, mainSite, type Site } from "./auth/sites";

/** Missive admins: Aegis emails in MISSIVE_ADMINS (comma-separated). */
export function isAdmin(email: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!email) return false;
  const admins = (env.MISSIVE_ADMINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return admins.includes(email.toLowerCase());
}

export function requireAdmin() {
  const user = requireUser();
  if (!isAdmin(user.email)) throw new ForbiddenException("Admins only");
  return user;
}

/**
 * Organizations are the sites Missive is served at, each signing in through
 * its own Aegis client and so its own tenant. MISSIVE_ORG_NAMES names them
 * ("missive=The AI Inc,bugmole-mail=Bugmole"); otherwise the host is used.
 */
function organizations(env: NodeJS.ProcessEnv = process.env) {
  const names = Object.fromEntries(
    (env.MISSIVE_ORG_NAMES ?? "").split(",").map((pair) => pair.split("=").map((s) => s.trim())).filter(([k, v]) => k && v),
  );
  return [mainSite(env), ...extraSites(env)].map((site: Site) => ({
    clientId: site.clientId,
    host: site.host,
    appUrl: site.appUrl,
    name: names[site.clientId] ?? site.host,
  }));
}

/** The organization a domain belongs to: the site served under it, else the main one. */
function orgForDomain(domain: string, orgs: ReturnType<typeof organizations>) {
  return orgs.find((o) => o.host === domain || o.host.endsWith(`.${domain}`)) ?? orgs[0]!;
}

const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);

/**
 * The admin console's API (like Zoho Mail's admin console): organizations and
 * their domains, everyone's accounts and mailboxes, and email groups.
 */
@Controller("api/v1/admin")
export class AdminController {
  constructor(
    private readonly pg: PostgresService,
    private readonly users: UsersService,
    private readonly groups: GroupsService,
  ) {}

  @Get("overview")
  async overview() {
    requireAdmin();
    const orgs = organizations();
    const { rows } = await this.pg.systemQuery(`SELECT name FROM domains ORDER BY name`);
    const domains = rows.map((r: any) => ({ name: r.name as string, org: orgForDomain(r.name, orgs).clientId }));
    const people = await this.users.directory();
    const groups = await Promise.all(
      (await this.groups.list()).map(async (g) => ({ ...g, org: orgForDomain(g.domain, orgs).clientId, members: await this.groups.members(g.id) })),
    );
    return {
      organizations: orgs.map((o) => ({ ...o, domains: domains.filter((d) => d.org === o.clientId).map((d) => d.name) })),
      domains,
      users: people,
      groups,
    };
  }

  @Post("groups")
  async createGroup(@Body() body: Record<string, unknown>) {
    const admin = requireAdmin();
    const address = (text(body.address) ?? "").toLowerCase();
    const [localPart, domain, ...rest] = address.split("@");
    if (!localPart || !domain || rest.length) throw new BadRequestException("Give the full address, like hello@bugmole.com");
    if (localPartProblem(localPart) === "invalid") throw new BadRequestException("Use letters, numbers and . _ - only");
    const group = await this.groups.create(address, text(body.name, 80), admin.id);
    if (!group) throw new ConflictException("That address is already in use, or its domain isn't hosted here");
    return group;
  }

  @Patch("groups/:id")
  async renameGroup(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    requireAdmin();
    if (!(await this.groups.rename(id, text(body.name, 80)))) throw new NotFoundException();
    return { ok: true };
  }

  @Delete("groups/:id")
  async deleteGroup(@Param("id") id: string) {
    requireAdmin();
    if (!(await this.groups.remove(id))) throw new NotFoundException();
    return { ok: true };
  }

  /** Adds a member, or changes their role (owner, moderator or member). */
  @Put("groups/:id/members/:userId")
  async setMember(@Param("id") id: string, @Param("userId") userId: string, @Body() body: Record<string, unknown>) {
    requireAdmin();
    const role = body.role as GroupRole;
    if (!GROUP_ROLES.includes(role)) throw new BadRequestException("Role is owner, moderator or member");
    if (!(await this.users.byId(userId))) throw new NotFoundException("No such user");
    const { rows } = await this.pg.systemQuery(`SELECT 1 FROM mail_groups WHERE id = $1`, [id]);
    if (!rows.length) throw new NotFoundException("No such group");
    await this.groups.setMember(id, userId, role);
    return { members: await this.groups.members(id) };
  }

  @Delete("groups/:id/members/:userId")
  async removeMember(@Param("id") id: string, @Param("userId") userId: string) {
    requireAdmin();
    if (!(await this.groups.removeMember(id, userId))) throw new NotFoundException();
    return { members: await this.groups.members(id) };
  }
}
