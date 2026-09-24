import { Controller, Get, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";
import { UsersService } from "../users.service";
import { GroupsService } from "../groups.service";

import { requireUser } from "../request-context";
import {
  SESSION_COOKIE, STATE_COOKIE, INVITE_COOKIE, SESSION_HOURS,
  seal, unseal, readCookie, cookie, randomToken, pkceChallenge, type Session,
} from "./session";
import { siteFor, type Site } from "./sites";

/**
 * Sign-in with Aegis ID (OIDC authorization code + PKCE, confidential client).
 * Env: AEGIS_ISSUER (default https://id.theaiinc.com), SESSION_SECRET, and
 * the Aegis client for each address Missive is served at (see sites.ts).
 */
const issuer = () => process.env.AEGIS_ISSUER ?? "https://id.theaiinc.com";
const redirectUri = (site: Site) => `${site.appUrl}/auth/callback`;

type IdClaims = { iss?: string; sub?: string; aud?: string | string[]; exp?: number; nonce?: string; email?: string; email_verified?: boolean; name?: string; mailbox_domain?: unknown ; roles?: unknown; role?: unknown; home_tenant_id?: unknown; managed_tenant_ids?: unknown; platform_admin?: unknown };
type OidcState = { state: string; verifier: string; nonce: string; returnTo: string; clientId: string; exp: number };

/** Checks the id_token's RS256 signature against Aegis's JWKS, then issuer, audience, expiry and nonce. */
async function verifyIdToken(token: string, nonce: string, clientId: string): Promise<IdClaims | null> {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") return null;
  const jwks = (await (await fetch(`${issuer()}/jwks`)).json()) as { keys: (JsonWebKey & { kid?: string })[] };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = createPublicKey({ key: jwk, format: "jwk" });
  if (!verifySignature("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(sig, "base64url"))) return null;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as IdClaims;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer() || !aud.includes(clientId)) return null;
  if (!claims.exp || claims.exp * 1000 < Date.now() || claims.nonce !== nonce) return null;
  return claims;
}

/** The person's Aegis account page (password, passkeys, two-step sign-in) in this site's tenant. */
export function aegisAccountUrl(site: Site): string {
  return `${issuer()}/account?client_id=${encodeURIComponent(site.clientId)}`;
}

/** Aegis's end_session URL; client_id identifies the app, so no id_token has to be kept. */
export function aegisLogoutUrl(site: Site): string {
  const url = new URL(`${issuer()}/session/end`);
  url.search = new URLSearchParams({
    client_id: site.clientId,
    post_logout_redirect_uri: `${site.appUrl}/`,
  }).toString();
  return url.toString();
}

/** Only same-app paths, so the sign-in can't be used as an open redirect. */
const safeReturn = (value: unknown) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";

@Controller()
export class AuthController {
  constructor(
    private readonly users: UsersService,
    private readonly groups: GroupsService,
  ) {}

  @Get("auth/login")
  login(@Req() req: Request, @Res() res: Response) {
    const site = siteFor(req);
    const verifier = randomToken();
    const saved: OidcState = {
      state: randomToken(),
      verifier,
      nonce: randomToken(),
      returnTo: safeReturn(req.query.returnTo),
      clientId: site.clientId,
      exp: Date.now() + 10 * 60_000,
    };
    const url = new URL(`${issuer()}/authorize`);
    url.search = new URLSearchParams({
      client_id: site.clientId,
      redirect_uri: redirectUri(site),
      response_type: "code",
      // "mailbox": Aegis adds mailbox_domain for a blank account that may claim a hosted mailbox.
      // "admin": Aegis adds the person's roles and managed tenants (who may use the admin console).
      scope: "openid email profile mailbox admin",
      // "Try again" after a refused sign-in asks Aegis for the login again,
      // instead of reusing the Aegis session that was just refused.
      ...(req.query.prompt === "login" ? { prompt: "login" } : {}),
      state: saved.state,
      nonce: saved.nonce,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
    }).toString();
    res.setHeader("set-cookie", cookie(STATE_COOKIE, seal(saved), 600));
    res.redirect(302, url.toString());
  }

  @Get("auth/callback")
  async callback(@Req() req: Request, @Res() res: Response) {
    const site = siteFor(req);
    const saved = unseal<OidcState>(readCookie(req.headers.cookie, STATE_COOKIE));
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!saved || saved.state !== req.query.state || saved.clientId !== site.clientId || !code) {
      return res.status(400).type("html").send(`<p>That sign-in expired. <a href="/auth/login">Try again</a>.</p>`);
    }
    const tokenResponse = await fetch(`${issuer()}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(site),
        client_id: site.clientId,
        client_secret: site.clientSecret,
        code_verifier: saved.verifier,
      }),
    });
    if (!tokenResponse.ok) {
      return res.status(502).type("html").send(`<p>Aegis didn't accept the sign-in. <a href="/auth/login?prompt=login">Try again</a> or <a href="/auth/logout">use another account</a>.</p>`);
    }
    const tokens = (await tokenResponse.json()) as { id_token?: string };
    const claims = tokens.id_token ? await verifyIdToken(tokens.id_token, saved.nonce, site.clientId) : null;
    if (!claims?.sub || !claims.email || claims.email_verified !== true) {
      return res.status(403).type("html").send(`<p>Your Aegis account needs a verified email. Verify it in Aegis, or ask your admin to set it up. <a href="/auth/login?prompt=login">Try again</a> or <a href="/auth/logout">use another account</a>.</p>`);
    }
    let user;
    try {
      user = await this.users.signIn(claims.sub, claims.email, claims.name);
    } catch {
      return res.status(403).type("html").send(`<p>${claims.email.replace(/[<>&"]/g, "")} is already linked to another Aegis account.</p>`);
    }
    // Their organization (the client and tenant they came in through) and admin rights, as Aegis says now.
    await this.users.recordSignIn(user.id, site.clientId, claims);
    // Refreshed on every sign-in: the offer follows what Aegis says now.
    await this.users.setMailboxOffer(user.id, typeof claims.mailbox_domain === "string" ? claims.mailbox_domain.toLowerCase() : null);
    // Came in through a mailbox invitation: that address is theirs now (once).
    const invite = unseal<{ token: string; exp: number }>(readCookie(req.headers.cookie, INVITE_COOKIE));
    if (invite) await this.users.claimInvite(invite.token, user.id);
    // An admin-provisioned account for a hosted address gets that mailbox.
    await this.users.provisionOwnAddress(user.id, claims.email, claims.name);
    const session: Session = { userId: user.id, exp: Date.now() + SESSION_HOURS * 3600_000 };
    res.setHeader("set-cookie", [
      cookie(SESSION_COOKIE, seal(session), SESSION_HOURS * 3600),
      cookie(STATE_COOKIE, "", 0),
      cookie(INVITE_COOKIE, "", 0),
    ]);
    res.redirect(302, saved.returnTo);
  }

  /**
   * Ends the Missive session *and* the Aegis one (OIDC RP-initiated logout).
   * Clearing only our cookie left the person signed in at Aegis, so the next
   * "Sign in" went straight back in without asking. Aegis confirms, then
   * returns to the site's address, which must be a registered post-logout URI.
   */
  @Get("auth/logout")
  logout(@Req() req: Request, @Res() res: Response) {
    res.setHeader("set-cookie", cookie(SESSION_COOKIE, "", 0));
    res.redirect(302, aegisLogoutUrl(siteFor(req)));
  }

  /** Who is signed in, and the hosted mailboxes they can read and send from. */
  @Get("api/v1/me")
  async me(@Req() req: Request) {
    const user = requireUser();
    // Their own mailboxes, then the groups they're in (kind, role).
    const [mailboxes, offerDomain] = await Promise.all([this.groups.addressesOf(user.id), this.users.mailboxOffer(user.id)]);
    return {
      id: user.id, email: user.email, name: user.name, mailboxes, mailboxOffer: offerDomain ? { domain: offerDomain } : null,
      // Password, passkeys and two-step sign-in live in Aegis (a passkey has to
      // be registered on Aegis's own origin); client_id picks this site's tenant.
      accountUrl: aegisAccountUrl(siteFor(req)),
      isAdmin: !!(await this.users.adminScope(user.id)),
    };
  }
}
