/**
 * Application-level encryption for email data at rest (Postgres, R2).
 *
 * - One master secret (MISSIVE_DATA_KEY, a Worker secret; backed up in arcana
 *   and in the aegis-idp-vault Secret Manager). Losing it makes every
 *   encrypted value unreadable.
 * - Keys are derived from it with HKDF-SHA256, one per scope: `user:<id>` for
 *   a user's own mail, `system:<name>` for data that exists before a user is
 *   known (e.g. raw inbound mail). One user's key can't open another's rows.
 * - Values are AES-256-GCM with a random 96-bit IV. The caller's `aad` label
 *   (e.g. "missives.body") is authenticated, so a ciphertext can't be moved to
 *   another column or object and still decrypt.
 * - Blind indexes (HMAC-SHA256 under their own derived key) allow equality
 *   lookups, e.g. finding a user by email, without storing the email.
 *
 * Uses only WebCrypto, so the same file runs in Node (backend) and in
 * Cloudflare Workers (edge), and both produce the same format.
 */

const te = new TextEncoder();
const td = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

/** Text values: "mv1." + base64url(iv || ciphertext+tag). */
export const TEXT_PREFIX = "mv1.";
/** Binary values (R2 objects): these magic bytes, then iv || ciphertext+tag. */
const BINARY_MAGIC = te.encode("MVE1");
const IV_BYTES = 12;
const HKDF_SALT = te.encode("missive/data-key/v1");

export type Scope = `user:${string}` | `system:${string}`;

export const userScope = (userId: string): Scope => `user:${userId}`;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const s = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function isEncryptedText(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(TEXT_PREFIX);
}

export function isEncryptedBytes(bytes: Uint8Array): boolean {
  return bytes.length > BINARY_MAGIC.length && BINARY_MAGIC.every((b, i) => bytes[i] === b);
}

export class DataCipher {
  private readonly master: Promise<CryptoKey>;
  private readonly keys = new Map<string, Promise<CryptoKey>>();

  private constructor(secret: string) {
    this.master = subtle().importKey("raw", te.encode(secret), "HKDF", false, ["deriveKey"]);
  }

  /** The secret is the MISSIVE_DATA_KEY value (at least 32 characters). */
  static fromSecret(secret: string | undefined): DataCipher {
    if (!secret || secret.length < 32) throw new Error("MISSIVE_DATA_KEY must be set (32+ characters)");
    return new DataCipher(secret);
  }

  private derive(info: string, algorithm: AesKeyGenParams | HmacKeyGenParams, usages: KeyUsage[]): Promise<CryptoKey> {
    const cacheKey = `${info}|${usages.join(",")}`;
    let key = this.keys.get(cacheKey);
    if (!key) {
      key = this.master.then((master) =>
        subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: te.encode(info) }, master, algorithm, false, usages),
      );
      this.keys.set(cacheKey, key);
    }
    return key;
  }

  private aesKey(scope: Scope) {
    return this.derive(`aes:${scope}`, { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]);
  }

  async encryptBytes(scope: Scope, aad: string, plain: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = new Uint8Array(
      // A copy, so WebCrypto gets a plain ArrayBuffer-backed view (TS 5.7+ BufferSource).
      await subtle().encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, await this.aesKey(scope), new Uint8Array(plain)),
    );
    const out = new Uint8Array(BINARY_MAGIC.length + IV_BYTES + ct.length);
    out.set(BINARY_MAGIC, 0);
    out.set(iv, BINARY_MAGIC.length);
    out.set(ct, BINARY_MAGIC.length + IV_BYTES);
    return out;
  }

  async decryptBytes(scope: Scope, aad: string, sealed: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
    const bytes = sealed instanceof Uint8Array ? sealed : new Uint8Array(sealed);
    if (!isEncryptedBytes(bytes)) throw new Error("not an encrypted object");
    const iv = bytes.slice(BINARY_MAGIC.length, BINARY_MAGIC.length + IV_BYTES);
    const ct = bytes.slice(BINARY_MAGIC.length + IV_BYTES);
    return new Uint8Array(
      await subtle().decrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, await this.aesKey(scope), ct),
    );
  }

  async encrypt(scope: Scope, aad: string, plain: string): Promise<string> {
    const sealed = await this.encryptBytes(scope, aad, te.encode(plain));
    return TEXT_PREFIX + b64url(sealed.subarray(BINARY_MAGIC.length));
  }

  async decrypt(scope: Scope, aad: string, value: string): Promise<string> {
    if (!isEncryptedText(value)) throw new Error("not an encrypted value");
    const body = fromB64url(value.slice(TEXT_PREFIX.length));
    const sealed = new Uint8Array(BINARY_MAGIC.length + body.length);
    sealed.set(BINARY_MAGIC, 0);
    sealed.set(body, BINARY_MAGIC.length);
    return td.decode(await this.decryptBytes(scope, aad, sealed));
  }

  /** Null-safe helpers for optional columns. */
  async encryptOptional(scope: Scope, aad: string, plain: string | null | undefined): Promise<string | null> {
    return plain == null ? null : this.encrypt(scope, aad, plain);
  }

  async decryptOptional(scope: Scope, aad: string, value: string | null | undefined): Promise<string | null> {
    return value == null ? null : this.decrypt(scope, aad, value);
  }

  /**
   * Keyed hash for equality lookups (hex). The value is normalised by the
   * caller (e.g. lower-cased email). Same input and label, same output; the
   * key never leaves the server, so the index can't be brute-forced from a
   * database copy alone.
   */
  async blindIndex(label: string, normalized: string): Promise<string> {
    const key = await this.derive(`bidx:${label}`, { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]);
    const mac = new Uint8Array(await subtle().sign("HMAC", key, te.encode(normalized)));
    return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  }
}
