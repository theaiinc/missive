import { Controller, Get, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";
import { UsersService } from "../users.service";
import { requireUser } from "../request-context";
import {
  SESSION_COOKIE, STATE_COOKIE, SESSION_HOURS,
  seal, unseal, readCookie, cookie, randomToken, pkceChallenge, type Session,
} from "./session";

/**
 * Sign-in with Aegis ID (OIDC authorization code + PKCE, confidential client).
 * Env: AEGIS_ISSUER (default https://id.theaiinc.com), AEGIS_CLIENT_ID,
 * AEGIS_CLIENT_SECRET, APP_URL, SESSION_SECRET.
 */
const issuer = () => process.env.AEGIS_ISSUER ?? "https://id.theaiinc.com";
const clientId = () => process.env.AEGIS_CLIENT_ID ?? "missive";
const appUrl = () => process.env.APP_URL ?? "http://localhost:5173";
const redirectUri = () => `${appUrl()}/auth/callback`;

type IdClaims = { iss?: string; sub?: string; aud?: string | string[]; exp?: number; nonce?: string; email?: string; email_verified?: boolean; name?: string };
type OidcState = { state: string; verifier: string; nonce: string; returnTo: string; exp: number };

/** Checks the id_token's RS256 signature against Aegis's JWKS, then issuer, audience, expiry and nonce. */
async function verifyIdToken(token: string, nonce: string): Promise<IdClaims | null> {
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
  if (claims.iss !== issuer() || !aud.includes(clientId())) return null;
  if (!claims.exp || claims.exp * 1000 < Date.now() || claims.nonce !== nonce) return null;
  return claims;
}

/** Only same-app paths, so the sign-in can't be used as an open redirect. */
const safeReturn = (value: unknown) =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";

@Controller()
export class AuthController {
  constructor(private readonly users: UsersService) {}

  @Get("auth/login")
  login(@Req() req: Request, @Res() res: Response) {
    const verifier = randomToken();
    const saved: OidcState = {
      state: randomToken(),
      verifier,
      nonce: randomToken(),
      returnTo: safeReturn(req.query.returnTo),
      exp: Date.now() + 10 * 60_000,
    };
    const url = new URL(`${issuer()}/authorize`);
    url.search = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: "openid email profile",
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
    const saved = unseal<OidcState>(readCookie(req.headers.cookie, STATE_COOKIE));
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!saved || saved.state !== req.query.state || !code) {
      return res.status(400).type("html").send(`<p>That sign-in expired. <a href="/auth/login">Try again</a>.</p>`);
    }
    const tokenResponse = await fetch(`${issuer()}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(),
        client_id: clientId(),
        client_secret: process.env.AEGIS_CLIENT_SECRET ?? "",
        code_verifier: saved.verifier,
      }),
    });
    if (!tokenResponse.ok) {
      return res.status(502).type("html").send(`<p>Aegis didn't accept the sign-in. <a href="/auth/login">Try again</a>.</p>`);
    }
    const tokens = (await tokenResponse.json()) as { id_token?: string };
    const claims = tokens.id_token ? await verifyIdToken(tokens.id_token, saved.nonce) : null;
    if (!claims?.sub || !claims.email || claims.email_verified !== true) {
      return res.status(403).type("html").send(`<p>Your Aegis account needs a verified email. <a href="/auth/login">Try again</a>.</p>`);
    }
    let user;
    try {
      user = await this.users.signIn(claims.sub, claims.email, claims.name);
    } catch {
      return res.status(403).type("html").send(`<p>${claims.email.replace(/[<>&"]/g, "")} is already linked to another Aegis account.</p>`);
    }
    const session: Session = { userId: user.id, email: user.email, name: user.name, exp: Date.now() + SESSION_HOURS * 3600_000 };
    res.setHeader("set-cookie", [
      cookie(SESSION_COOKIE, seal(session), SESSION_HOURS * 3600),
      cookie(STATE_COOKIE, "", 0),
    ]);
    res.redirect(302, saved.returnTo);
  }

  @Get("auth/logout")
  logout(@Res() res: Response) {
    res.setHeader("set-cookie", cookie(SESSION_COOKIE, "", 0));
    res.redirect(302, "/");
  }

  /** Who is signed in, and the hosted mailboxes they can read and send from. */
  @Get("api/v1/me")
  async me() {
    const user = requireUser();
    const mailboxes = await this.users.mailboxesOf(user.id);
    return { id: user.id, email: user.email, name: user.name, mailboxes };
  }
}
