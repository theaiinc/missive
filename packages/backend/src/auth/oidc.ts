import { createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";

export const issuer = () => process.env.AEGIS_ISSUER ?? "https://id.theaiinc.com";

export type IdClaims = { iss?: string; sub?: string; aud?: string | string[]; exp?: number; nonce?: string; email?: string; email_verified?: boolean; name?: string; mailbox_domain?: unknown ; roles?: unknown; role?: unknown; home_tenant_id?: unknown; managed_tenant_ids?: unknown; platform_admin?: unknown; console_platform_admin?: unknown; console_managed_tenant_ids?: unknown };

/**
 * Checks the id_token's RS256 signature against Aegis's JWKS, then issuer,
 * audience, expiry and nonce. A refreshed id_token carries no nonce: pass null.
 */
export async function verifyIdToken(token: string, nonce: string | null, clientId: string): Promise<IdClaims | null> {
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
  if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
  if (nonce !== null && claims.nonce !== nonce) return null;
  return claims;
}
