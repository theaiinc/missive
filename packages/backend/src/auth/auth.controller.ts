import { Controller, Get, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { UsersService } from "../users.service";
import { GroupsService } from "../groups.service";

import { requireUser } from "../request-context";
import {
  SESSION_COOKIE, STATE_COOKIE, INVITE_COOKIE, REFRESH_COOKIE, SESSION_HOURS, REFRESH_COOKIE_SECONDS,
  seal, unseal, encrypt, readCookie, cookie, randomToken, pkceChallenge, type Session, type SavedRefresh,
} from "./session";
import { issuer, verifyIdToken } from "./oidc";
import { siteFor, type Site } from "./sites";
import { syncSignIn, type IdClaimsWithIdentity } from "./refresh";
import { mintDesktopCode, redeemDesktopCode, returnToAppPage } from "./desktop-handoff";

/**
 * Sign-in with Aegis ID (OIDC authorization code + PKCE, confidential client).
 * Env: AEGIS_ISSUER (default https://id.theaiinc.com), SESSION_SECRET, and
 * the Aegis client for each address Missive is served at (see sites.ts).
 */
const redirectUri = (site: Site) => `${site.appUrl}/auth/callback`;

/** desktop: started from the desktop app, which gets the session (desktop-handoff.ts) instead of this browser. */
type OidcState = { state: string; verifier: string; nonce: string; returnTo: string; clientId: string; desktop?: boolean; exp: number };

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

/**
 * One state cookie per sign-in in progress, named after its state, so two at
 * once (two tabs, or the desktop app opening the browser twice) don't spoil
 * each other: with one shared cookie, finishing the older one said "expired".
 */
const stateCookie = (state: unknown) =>
  typeof state === "string" && /^[A-Za-z0-9_-]{16,}$/.test(state) ? `${STATE_COOKIE}_${state.slice(0, 16)}` : null;

/** Set while a sign-in from the desktop app is in progress, so "Try again" keeps it one. */
const DESKTOP_COOKIE = "missive_desktop";
const tryAgain = (req: Request, extra = "") => {
  const desktop = readCookie(req.headers.cookie, DESKTOP_COOKIE) === "1";
  const query = [desktop ? "desktop=1" : "", extra].filter(Boolean).join("&");
  return `/auth/login${query ? `?${query}` : ""}`;
};

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
      ...(req.query.desktop === "1" ? { desktop: true } : {}),
      exp: Date.now() + 10 * 60_000,
    };
    const url = new URL(`${issuer()}/authorize`);
    url.search = new URLSearchParams({
      client_id: site.clientId,
      redirect_uri: redirectUri(site),
      response_type: "code",
      // "mailbox": Aegis adds mailbox_domain for a blank account that may claim a hosted mailbox.
      // "admin": the person's roles in their tenant; "console": their Aegis console
      // rights (platform admin, managed tenants). Together: who may use the admin console.
      // "offline_access": a refresh token, so a session that runs out is renewed
      // while the person keeps using Missive (refresh.ts).
      scope: "openid email profile mailbox admin console offline_access",
      // "Try again" after a refused sign-in asks Aegis for the login again,
      // instead of reusing the Aegis session that was just refused. Aegis drops
      // offline_access under a prompt that doesn't include "consent".
      ...(req.query.prompt === "login" ? { prompt: "login consent" } : {}),
      state: saved.state,
      nonce: saved.nonce,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
    }).toString();
    res.setHeader("set-cookie", [
      cookie(stateCookie(saved.state)!, seal(saved), 600),
      saved.desktop ? cookie(DESKTOP_COOKIE, "1", 600) : cookie(DESKTOP_COOKIE, "", 0),
    ]);
    res.redirect(302, url.toString());
  }

  @Get("auth/callback")
  async callback(@Req() req: Request, @Res() res: Response) {
    const site = siteFor(req);
    const savedName = stateCookie(req.query.state);
    const saved = savedName ? unseal<OidcState>(readCookie(req.headers.cookie, savedName)) : null;
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!saved || saved.state !== req.query.state || saved.clientId !== site.clientId || !code) {
      return res.status(400).type("html").send(`<p>That sign-in expired. <a href="${tryAgain(req)}">Try again</a>.</p>`);
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
      return res.status(502).type("html").send(`<p>Aegis didn't accept the sign-in. <a href="${tryAgain(req, "prompt=login")}">Try again</a> or <a href="/auth/logout">use another account</a>.</p>`);
    }
    const tokens = (await tokenResponse.json()) as { id_token?: string; refresh_token?: string };
    const claims = tokens.id_token ? await verifyIdToken(tokens.id_token, saved.nonce, site.clientId) : null;
    if (!claims?.sub || !claims.email || claims.email_verified !== true) {
      return res.status(403).type("html").send(`<p>Your Aegis account needs a verified email. Verify it in Aegis, or ask your admin to set it up. <a href="${tryAgain(req, "prompt=login")}">Try again</a> or <a href="/auth/logout">use another account</a>.</p>`);
    }
    let user;
    try {
      user = await syncSignIn(this.users, site.clientId, claims as IdClaimsWithIdentity);
    } catch {
      return res.status(403).type("html").send(`<p>${claims.email.replace(/[<>&"]/g, "")} is already linked to another Aegis account.</p>`);
    }
    // Came in through a mailbox invitation: that address is theirs now (once).
    const invite = unseal<{ token: string; exp: number }>(readCookie(req.headers.cookie, INVITE_COOKIE));
    if (invite) await this.users.claimInvite(invite.token, user.id);
    // An admin-provisioned account for a hosted address gets that mailbox.
    await this.users.provisionOwnAddress(user.id, claims.email, claims.name);
    const session: Session = { userId: user.id, exp: Date.now() + SESSION_HOURS * 3600_000 };
    const refresh: SavedRefresh | null = tokens.refresh_token
      ? { token: tokens.refresh_token, clientId: site.clientId, exp: Date.now() + REFRESH_COOKIE_SECONDS * 1000 }
      : null;
    const sessionCookies = [
      cookie(SESSION_COOKIE, seal(session), SESSION_HOURS * 3600),
      ...(refresh ? [cookie(REFRESH_COOKIE, encrypt(refresh), REFRESH_COOKIE_SECONDS)] : []),
    ];
    const done = [cookie(savedName!, "", 0), cookie(DESKTOP_COOKIE, "", 0), cookie(STATE_COOKIE, "", 0), cookie(INVITE_COOKIE, "", 0)];
    if (saved.desktop) {
      // The desktop app redeems this at /auth/desktop; the browser stays signed out of Missive.
      const page = returnToAppPage(mintDesktopCode(sessionCookies));
      res.setHeader("set-cookie", done);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", page.csp);
      return res.type("html").send(page.html);
    }
    res.setHeader("set-cookie", [...sessionCookies, ...done]);
    res.redirect(302, saved.returnTo);
  }

  /** The desktop app's web view, back from missive://auth?code=… (desktop-handoff.ts): its session, once. */
  @Get("auth/desktop")
  desktop(@Req() req: Request, @Res() res: Response) {
    const cookies = redeemDesktopCode(req.query.code);
    res.setHeader("Cache-Control", "no-store");
    if (!cookies) {
      // The same missive:// link opened again (the browser page's button): already signed in, carry on.
      if (unseal<Session>(readCookie(req.headers.cookie, SESSION_COOKIE))) return res.redirect(302, "/inbox");
      return res.status(400).type("html").send(`<p>That sign-in expired. <a href="/auth/login">Try again</a>.</p>`);
    }
    res.setHeader("set-cookie", cookies);
    res.redirect(302, "/inbox");
  }

  /**
   * Ends the Missive session *and* the Aegis one (OIDC RP-initiated logout).
   * Clearing only our cookie left the person signed in at Aegis, so the next
   * "Sign in" went straight back in without asking. Aegis confirms, then
   * returns to the site's address, which must be a registered post-logout URI.
   */
  @Get("auth/logout")
  logout(@Req() req: Request, @Res() res: Response) {
    res.setHeader("set-cookie", [cookie(SESSION_COOKIE, "", 0), cookie(REFRESH_COOKIE, "", 0)]);
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
