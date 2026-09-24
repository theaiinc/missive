import { BadRequestException, Body, ConflictException, Controller, Get, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { UsersService } from "./users.service";
import { localPartProblem } from "./mailbox-claim";
import { extraSites, mainSite } from "./auth/sites";
import { INVITE_COOKIE, cookie, seal } from "./auth/session";
import { currentUser } from "./request-context";
import { isAdmin } from "./admin.controller";

const INVITE_MINUTES = 30;

function adminAllowed(header: string | undefined): boolean {
  const secret = process.env.ADMIN_TOKEN;
  if (!secret || secret.length < 32 || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const page = (res: Response, status: number, title: string, text: string) =>
  res.status(status).type("html").send(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`,
  );

/**
 * Invitations to one specific hosted mailbox.
 *
 * An admin (ADMIN_TOKEN) creates one for an address and gets a link on the
 * site that serves that domain. Opening the link remembers the invitation for
 * the sign-in that follows; after Aegis sign-in (or sign-up), the callback
 * gives that person the mailbox (see AuthController.callback).
 */
@Controller()
export class InviteController {
  constructor(private readonly users: UsersService) {}

  @Post("api/v1/admin/mailbox-invites")
  async create(@Req() req: Request, @Body() body: Record<string, unknown>) {
    // The admin token (scripts), or a signed-in admin (the console).
    if (!adminAllowed(req.headers.authorization) && !isAdmin(currentUser()?.email)) throw new UnauthorizedException();
    const address = typeof body.address === "string" ? body.address.trim().toLowerCase() : "";
    const [localPart, domain] = address.split("@");
    if (!localPart || !domain || address.split("@").length !== 2) throw new BadRequestException("Give the full address, like nhi.yen@bugmole.com");
    if (localPartProblem(localPart)) throw new BadRequestException("That address isn't allowed");
    const days = Math.min(Math.max(Number(body.days) || 7, 1), 30);
    const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : undefined;
    const invite = await this.users.createInvite(address, displayName, days);
    if (!invite) throw new ConflictException("That address already has a mailbox, or its domain isn't hosted here");
    // The link goes to the site for that domain (mail.bugmole.com for bugmole.com), else the main one.
    const site = extraSites().find((s) => s.host.endsWith(`.${domain}`) || s.host === domain) ?? mainSite();
    return { address, url: `${site.appUrl}/auth/join?token=${invite.token}`, expiresAt: invite.expiresAt.toISOString() };
  }

  /** The invitation link: checks it, remembers it for this sign-in, and goes to sign-in. */
  @Get("auth/join")
  async join(@Req() req: Request, @Res() res: Response) {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const address = token ? await this.users.openInvite(token) : null;
    if (!address) {
      return page(res, 404, "This invitation isn't valid", "The link is wrong, has expired, or was already used. Ask for a new one.");
    }
    res.setHeader("set-cookie", cookie(INVITE_COOKIE, seal({ token, exp: Date.now() + INVITE_MINUTES * 60_000 }), INVITE_MINUTES * 60));
    res.redirect(302, "/auth/login");
  }
}
