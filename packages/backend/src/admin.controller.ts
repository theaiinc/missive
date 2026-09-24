import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post, Put } from "@nestjs/common";
import { requireUser } from "./request-context";
import { PostgresService } from "./storage/postgres.service";
import { UsersService, type AdminScope } from "./users.service";
import { GROUP_ROLES, GroupsService, type GroupRole } from "./groups.service";
import { localPartProblem } from "./mailbox-claim";
import { extraSites, mainSite, type Site } from "./auth/sites";

export type Organization = { clientId: string; tenantId: string | null; host: string; appUrl: string; name: string };

/**
 * Admin rights come from Aegis (scope "admin" at sign-in): an ADMIN of their
 * tenant, a manager of other tenants, or a platform admin. Each admin sees
 * and manages only the organizations (tenants) they administer.
 */
@Injectable()
export class AdminAccess {
  constructor(
    private readonly pg: PostgresService,
    private readonly users: UsersService,
  ) {}

  /** The signed-in admin and what they may administer; 403 for anyone else. */
  async require(): Promise<{ id: string; scope: AdminScope }> {
    const user = requireUser();
    const scope = await this.users.adminScope(user.id);
    if (!scope) throw new ForbiddenException("Admins only");
    return { id: user.id, scope };
  }

  /**
   * Organizations are the sites Missive is served at, each signing in through
   * its own Aegis client and so one tenant. MISSIVE_ORG_NAMES names them
   * ("missive=The AI Inc,bugmole-mail=Bugmole"); otherwise the host is used.
   */
  async organizations(env: NodeJS.ProcessEnv = process.env): Promise<Organization[]> {
    const tenants = await this.users.clientTenants();
    const names = Object.fromEntries(
      (env.MISSIVE_ORG_NAMES ?? "").split(",").map((pair) => pair.split("=").map((s) => s.trim())).filter(([k, v]) => k && v),
    );
    return [mainSite(env), ...extraSites(env)].map((site: Site) => ({
      clientId: site.clientId,
      tenantId: tenants[site.clientId] ?? null,
      host: site.host,
      appUrl: site.appUrl,
      name: names[site.clientId] ?? site.host,
    }));
  }

  /** The organization a domain belongs to: the site served under it, else the main one. */
  orgForDomain(domain: string, orgs: Organization[]): Organization {
    return orgs.find((o) => o.host === domain || o.host.endsWith(`.${domain}`)) ?? orgs[0]!;
  }

  /** A tenant this admin administers (platform admins administer all). */
  covers(scope: AdminScope, tenantId: string | null): boolean {
    return scope.platform || (!!tenantId && scope.tenants.includes(tenantId));
  }

  /** Whether this admin may manage addresses at `domain`. */
  async coversDomain(scope: AdminScope, domain: string): Promise<boolean> {
    return this.covers(scope, this.orgForDomain(domain, await this.organizations()).tenantId);
  }
}

const text = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);

/**
 * The admin console's API (like Zoho Mail's admin console): organizations and
 * their domains, people's accounts and mailboxes, and email groups, limited to
 * the tenants the admin administers in Aegis.
 */
@Controller("api/v1/admin")
export class AdminController {
  constructor(
    private readonly pg: PostgresService,
    private readonly users: UsersService,
    private readonly groups: GroupsService,
    private readonly access: AdminAccess,
  ) {}

  @Get("overview")
  async overview() {
    const { scope } = await this.access.require();
    const orgs = (await this.access.organizations()).filter((o) => this.access.covers(scope, o.tenantId));
    const all = await this.access.organizations();
    const { rows } = await this.pg.systemQuery(`SELECT name FROM domains ORDER BY name`);
    const domains = rows
      .map((r: any) => ({ name: r.name as string, org: this.access.orgForDomain(r.name, all).clientId }))
      .filter((d) => orgs.some((o) => o.clientId === d.org));
    const people = (await this.users.directory()).filter((u) => scope.platform || (u.tenant && scope.tenants.includes(u.tenant)));
    const groups = await Promise.all(
      (await this.groups.list())
        .map((g) => ({ ...g, org: this.access.orgForDomain(g.domain, all).clientId }))
        .filter((g) => orgs.some((o) => o.clientId === g.org))
        .map(async (g) => ({ ...g, members: await this.groups.members(g.id) })),
    );
    return {
      scope: { platform: scope.platform },
      organizations: orgs.map((o) => ({ ...o, domains: domains.filter((d) => d.org === o.clientId).map((d) => d.name) })),
      domains,
      users: people,
      groups,
    };
  }

  /** The group, if it's in an organization this admin administers. */
  private async groupFor(scope: AdminScope, id: string) {
    const group = (await this.groups.list()).find((g) => g.id === id);
    if (!group || !(await this.access.coversDomain(scope, group.domain))) throw new NotFoundException("No such group");
    return group;
  }

  @Post("groups")
  async createGroup(@Body() body: Record<string, unknown>) {
    const admin = await this.access.require();
    const address = (text(body.address) ?? "").toLowerCase();
    const [localPart, domain, ...rest] = address.split("@");
    if (!localPart || !domain || rest.length) throw new BadRequestException("Give the full address, like hello@bugmole.com");
    if (localPartProblem(localPart) === "invalid") throw new BadRequestException("Use letters, numbers and . _ - only");
    if (!(await this.access.coversDomain(admin.scope, domain))) throw new ForbiddenException("You don't administer that domain's organization");
    const group = await this.groups.create(address, text(body.name, 80), admin.id);
    if (!group) throw new ConflictException("That address is already in use, or its domain isn't hosted here");
    return group;
  }

  @Patch("groups/:id")
  async renameGroup(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    const { scope } = await this.access.require();
    await this.groupFor(scope, id);
    await this.groups.rename(id, text(body.name, 80));
    return { ok: true };
  }

  @Delete("groups/:id")
  async deleteGroup(@Param("id") id: string) {
    const { scope } = await this.access.require();
    await this.groupFor(scope, id);
    await this.groups.remove(id);
    return { ok: true };
  }

  /** Adds a member, or changes their role (owner, moderator or member). Members come from the admin's organizations. */
  @Put("groups/:id/members/:userId")
  async setMember(@Param("id") id: string, @Param("userId") userId: string, @Body() body: Record<string, unknown>) {
    const { scope } = await this.access.require();
    const role = body.role as GroupRole;
    if (!GROUP_ROLES.includes(role)) throw new BadRequestException("Role is owner, moderator or member");
    await this.groupFor(scope, id);
    const person = (await this.users.directory()).find((u) => u.id === userId);
    if (!person || !(scope.platform || (person.tenant && scope.tenants.includes(person.tenant)))) throw new NotFoundException("No such user");
    await this.groups.setMember(id, userId, role);
    return { members: await this.groups.members(id) };
  }

  @Delete("groups/:id/members/:userId")
  async removeMember(@Param("id") id: string, @Param("userId") userId: string) {
    const { scope } = await this.access.require();
    await this.groupFor(scope, id);
    if (!(await this.groups.removeMember(id, userId))) throw new NotFoundException();
    return { members: await this.groups.members(id) };
  }
}
