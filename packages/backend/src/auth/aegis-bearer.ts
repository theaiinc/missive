import { createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";

/**
 * Aegis access tokens for Missive's API: another app (Simasis) connects
 * Missive through Aegis (OAuth, `resource` = MISSIVE_API_RESOURCE), and calls
 * the API as the person with `Authorization: Bearer <JWT>`. No token to paste.
 *
 * Aegis lists this resource in its OIDC_RESOURCE_SERVERS with the scope
 * missive:read, and signs the token (RS256, its /jwks) with aud = the resource
 * and the person's Aegis subject. Read-only: such a token reaches only the
 * GET routes in AEGIS_READ_ROUTES.
 */
export const AEGIS_API_SCOPE = "missive:read";

const issuer = (env: NodeJS.ProcessEnv) => (env.AEGIS_ISSUER ?? "https://id.theaiinc.com").replace(/\/+$/, "");

/** The OAuth resource Aegis issues these tokens for (their audience). */
export function aegisApiResource(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MISSIVE_API_RESOURCE ?? `${env.APP_URL ?? "http://localhost:5173"}/api`).replace(/\/+$/, "");
}

/** What another app may read with an Aegis token: who you are, and your mail. Nothing else. */
const AEGIS_READ_ROUTES = [
  /^\/api\/v1\/me$/,
  /^\/api\/v1\/search$/,
  /^\/api\/v1\/missive\/[^/]+$/,
  /^\/api\/v1\/thread\/[^/]+(\/missives)?$/,
  /^\/api\/v1\/recent-missives$/,
  /^\/api\/v1\/digest$/,
];

export const aegisTokenAllowed = (method: string, path: string) =>
  method === "GET" && AEGIS_READ_ROUTES.some((route) => route.test(path));

/** Shaped like a JWT (three base64url parts); msv_ tokens and random values are not. */
export const looksLikeJwt = (value: string) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);

type Jwk = JsonWebKey & { kid?: string };
type FetchJson = (url: string) => Promise<any>;

const defaultFetchJson: FetchJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
};

let keyCache: { issuer: string; at: number; keys: Jwk[] } | null = null;
const KEYS_TTL_MS = 10 * 60_000;

async function signingKey(iss: string, kid: string | undefined, fetchJson: FetchJson): Promise<Jwk | undefined> {
  const find = (keys: Jwk[]) => keys.find((k) => k.kty === "RSA" && (!kid || k.kid === kid));
  const fresh = keyCache && keyCache.issuer === iss && Date.now() - keyCache.at < KEYS_TTL_MS;
  const cached = fresh ? find(keyCache!.keys) : undefined;
  if (cached) return cached;
  // Unknown kid (Aegis rotated its keys) or a stale cache: fetch once.
  const jwks = await fetchJson(`${iss}/jwks`);
  const keys: Jwk[] = Array.isArray(jwks?.keys) ? jwks.keys : [];
  keyCache = { issuer: iss, at: Date.now(), keys };
  return find(keys);
}

/** For tests. */
export function resetAegisKeyCache(): void {
  keyCache = null;
}

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/**
 * The Aegis subject a token was issued to, when it is a valid Missive API
 * token: RS256 signature from Aegis's JWKS, issuer, audience, expiry, scope.
 * Throws with a short reason otherwise.
 */
export async function verifyAegisApiToken(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchJson: FetchJson = defaultFetchJson,
): Promise<{ sub: string; email?: string }> {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) throw new Error("malformed");
  let header: { alg?: string; kid?: string };
  let claims: Record<string, any>;
  try {
    header = decode(h);
    claims = decode(p);
  } catch {
    throw new Error("malformed");
  }
  if (header.alg !== "RS256") throw new Error("alg");
  const iss = issuer(env);
  const jwk = await signingKey(iss, header.kid, fetchJson);
  if (!jwk) throw new Error("unknown_key");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  if (!verifySignature("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(sig, "base64url"))) throw new Error("signature");
  if (String(claims.iss ?? "").replace(/\/+$/, "") !== iss) throw new Error("issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(aegisApiResource(env))) throw new Error("audience");
  const now = Date.now() / 1000;
  if (typeof claims.exp !== "number" || claims.exp < now) throw new Error("expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) throw new Error("not_yet_valid");
  if (!String(claims.scope ?? "").split(" ").includes(AEGIS_API_SCOPE)) throw new Error("scope");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("subject");
  return { sub: claims.sub, email: claims.email_verified === true && typeof claims.email === "string" ? claims.email : undefined };
}
