import { createHmac, timingSafeEqual, randomBytes, createHash } from "node:crypto";

// Signed (not encrypted) cookies: they carry ids and an expiry, nothing secret.

export const SESSION_COOKIE = "missive_session";
export const STATE_COOKIE = "missive_oidc";
export const SESSION_HOURS = 12;

/**
 * Only ids and an expiry: the cookie is signed, not encrypted, so it must not
 * carry the person's email or name (the request looks those up instead).
 */
export type Session = { userId: string; exp: number };

const b64url = (buf: Buffer) => buf.toString("base64url");

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new Error("SESSION_SECRET must be set (32+ characters)");
  return value;
}

export function seal(value: unknown): string {
  const body = b64url(Buffer.from(JSON.stringify(value)));
  const sig = b64url(createHmac("sha256", secret()).update(body).digest());
  return `${body}.${sig}`;
}

/** Returns the value if the signature checks out and `exp` hasn't passed. */
export function unseal<T extends { exp: number }>(token: string | undefined): T | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret()).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString()) as T;
    return typeof value.exp === "number" && value.exp > Date.now() ? value : null;
  } catch {
    return null;
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return undefined;
}

export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  // Secure is dropped only for plain-http local development.
  const secure = (process.env.APP_URL ?? "").startsWith("https://") ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export const randomToken = () => b64url(randomBytes(32));
export const pkceChallenge = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());
