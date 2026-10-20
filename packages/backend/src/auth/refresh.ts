import type { RequestUser } from "../request-context";
import type { UsersService } from "../users.service";
import { issuer, verifyIdToken, type IdClaims } from "./oidc";
import {
  REFRESH_COOKIE, REFRESH_COOKIE_SECONDS, SESSION_COOKIE, SESSION_HOURS,
  cookie, decrypt, encrypt, readCookie, seal, type SavedRefresh, type Session,
} from "./session";
import type { Site } from "./sites";

/**
 * Staying signed in. The sign-in asks Aegis for offline_access (with
 * prompt=consent, which Aegis requires for it; auth.controller.ts) and keeps the
 * refresh token in an encrypted cookie (REFRESH_COOKIE). When the 12-hour
 * session runs out, the auth middleware trades it here for a fresh session,
 * so someone who keeps using Missive stays in until Aegis ends the sign-in
 * (the missive client is on Aegis's "long" policy: 30 days after the last
 * refresh, at most 90 after signing in).
 */

export type IdClaimsWithIdentity = IdClaims & { sub: string; email: string };

/**
 * What a sign-in, and each refresh, records from Aegis: the account, its
 * organization and admin rights, and the hosted mailbox offer, as Aegis says now.
 */
export async function syncSignIn(users: UsersService, clientId: string, claims: IdClaimsWithIdentity): Promise<RequestUser> {
  const user = await users.signIn(claims.sub, claims.email, claims.name);
  await users.recordSignIn(user.id, clientId, claims);
  await users.setMailboxOffer(user.id, typeof claims.mailbox_domain === "string" ? claims.mailbox_domain.toLowerCase() : null);
  return user;
}

export type Refreshed = { userId: string; cookies: string[] } | { clear: true } | null;

/** How long one refresh's result answers the other requests that carried the same cookie. */
const SHARED_MS = 30_000;
const recent = new Map<string, { at: number; result: Promise<Refreshed> }>();

/**
 * A fresh session from the refresh cookie, with the cookies to set. Null when
 * there's nothing to do or Aegis is unavailable (try again next request);
 * { clear: true } when the sign-in is over and the cookie should go.
 *
 * A page whose session ran out sends several requests at once, all with the
 * same refresh token. They share one refresh: separately, a rotated token
 * would be refused for all but the first, and those answers would clear the
 * cookie the first had just renewed (signing the person out).
 */
export function refreshSession(
  cookieHeader: string | undefined,
  site: Site,
  users: UsersService,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<Refreshed> {
  const raw = readCookie(cookieHeader, REFRESH_COOKIE);
  if (!raw) return Promise.resolve(null);
  const now = Date.now();
  for (const [k, v] of recent) if (now - v.at > SHARED_MS) recent.delete(k);
  const key = `${site.clientId}|${raw}`;
  const shared = recent.get(key);
  if (shared) return shared.result;
  const result = refreshOnce(raw, site, users, fetchImpl);
  recent.set(key, { at: now, result });
  // Aegis unreachable: let the next request try again rather than reuse that.
  void result.then((r) => { if (r === null) recent.delete(key); }, () => recent.delete(key));
  return result;
}

async function refreshOnce(raw: string, site: Site, users: UsersService, fetchImpl: typeof fetch): Promise<Refreshed> {
  const saved = decrypt<SavedRefresh>(raw);
  // Another site's sign-in (each site is its own Aegis client) or a broken cookie.
  if (!saved || saved.clientId !== site.clientId) return { clear: true };
  let response: Response;
  try {
    response = await fetchImpl(`${issuer()}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: saved.token,
        client_id: site.clientId,
        client_secret: site.clientSecret,
      }),
    });
  } catch {
    return null;
  }
  // invalid_grant: expired, revoked, or the person signed out of Aegis.
  if (response.status === 400 || response.status === 401) return { clear: true };
  if (!response.ok) return null;
  const tokens = (await response.json()) as { id_token?: string; refresh_token?: string };
  const claims = tokens.id_token ? await verifyIdToken(tokens.id_token, null, site.clientId) : null;
  if (!claims?.sub || !claims.email || claims.email_verified !== true) return { clear: true };
  let user: RequestUser;
  try {
    user = await syncSignIn(users, site.clientId, claims as IdClaimsWithIdentity);
  } catch {
    return { clear: true };
  }
  const session: Session = { userId: user.id, exp: Date.now() + SESSION_HOURS * 3600_000 };
  // Aegis may rotate the refresh token; keep whichever is current.
  const next: SavedRefresh = { token: tokens.refresh_token ?? saved.token, clientId: site.clientId, exp: Date.now() + REFRESH_COOKIE_SECONDS * 1000 };
  return {
    userId: user.id,
    cookies: [cookie(SESSION_COOKIE, seal(session), SESSION_HOURS * 3600), cookie(REFRESH_COOKIE, encrypt(next), REFRESH_COOKIE_SECONDS)],
  };
}
