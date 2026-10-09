import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { aegisApiResource, aegisTokenAllowed, looksLikeJwt, resetAegisKeyCache, verifyAegisApiToken } from "../auth/aegis-bearer";
import { AuthMiddleware } from "../auth/auth.middleware";
import { currentUser, type RequestUser } from "../request-context";

const ISSUER = "https://id.example.com";
const RESOURCE = "https://missive.example.com/api";
const env = { AEGIS_ISSUER: ISSUER, APP_URL: "https://missive.example.com" } as NodeJS.ProcessEnv;
const ALICE: RequestUser = { id: "11111111-1111-4111-8111-111111111111", email: "alice@example.com", name: "Alice" };
const ALICE_SUB = "aegis-sub-alice";

const aegisKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...aegisKey.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] };

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function jwt(claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string; alg?: string } = {}) {
  const head = b64({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "at+jwt" });
  const body = b64(claims);
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), opts.key ?? aegisKey.privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

const valid = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  sub: ALICE_SUB,
  aud: RESOURCE,
  scope: "openid email offline_access missive:read",
  exp: Math.floor(Date.now() / 1000) + 3600,
  email: ALICE.email,
  email_verified: true,
  ...over,
});

const fetchJson = vi.fn(async (url: string) => {
  if (url === `${ISSUER}/jwks`) return jwks;
  throw new Error(`unexpected ${url}`);
});

beforeEach(() => {
  resetAegisKeyCache();
  fetchJson.mockClear();
});

describe("aegisApiResource", () => {
  it("is APP_URL/api unless MISSIVE_API_RESOURCE says otherwise", () => {
    expect(aegisApiResource(env)).toBe(RESOURCE);
    expect(aegisApiResource({ ...env, MISSIVE_API_RESOURCE: "https://x.example.com/api/" })).toBe("https://x.example.com/api");
  });
});

describe("verifyAegisApiToken", () => {
  it("accepts a token Aegis issued for this API", async () => {
    await expect(verifyAegisApiToken(jwt(valid()), env, fetchJson)).resolves.toEqual({ sub: ALICE_SUB, email: ALICE.email });
  });

  it("caches Aegis's keys", async () => {
    await verifyAegisApiToken(jwt(valid()), env, fetchJson);
    await verifyAegisApiToken(jwt(valid()), env, fetchJson);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another app's audience", valid({ aud: "https://app.simasis.com/api/v1/mcp" }), "audience"],
    ["another issuer", valid({ iss: "https://evil.example.com" }), "issuer"],
    ["an expired token", valid({ exp: Math.floor(Date.now() / 1000) - 5 }), "expired"],
    ["no missive:read scope", valid({ scope: "openid email" }), "scope"],
    ["no subject", valid({ sub: "" }), "subject"],
  ])("refuses %s", async (_name, claims, reason) => {
    await expect(verifyAegisApiToken(jwt(claims), env, fetchJson)).rejects.toThrow(reason);
  });

  it("refuses a token signed with another key", async () => {
    await expect(verifyAegisApiToken(jwt(valid(), { key: otherKey.privateKey }), env, fetchJson)).rejects.toThrow("signature");
  });

  it("refuses an unknown key id and other algorithms", async () => {
    await expect(verifyAegisApiToken(jwt(valid(), { kid: "nope" }), env, fetchJson)).rejects.toThrow("unknown_key");
    await expect(verifyAegisApiToken(jwt(valid(), { alg: "HS256" }), env, fetchJson)).rejects.toThrow("alg");
  });

  it("leaves out an unverified email", async () => {
    await expect(verifyAegisApiToken(jwt(valid({ email_verified: false })), env, fetchJson)).resolves.toEqual({ sub: ALICE_SUB, email: undefined });
  });
});

describe("aegisTokenAllowed", () => {
  it("allows only the read routes, only with GET", () => {
    for (const path of ["/api/v1/me", "/api/v1/search", "/api/v1/missive/abc", "/api/v1/thread/abc", "/api/v1/thread/abc/missives", "/api/v1/recent-missives", "/api/v1/digest"]) {
      expect(aegisTokenAllowed("GET", path), path).toBe(true);
    }
    expect(aegisTokenAllowed("POST", "/api/v1/search")).toBe(false);
    for (const path of ["/api/v1/api-tokens", "/api/v1/admin/users", "/api/v1/connectors", "/api/v1/missive/abc/move", "/api/v1/chat"]) {
      expect(aegisTokenAllowed("GET", path), path).toBe(false);
    }
  });

  it("tells JWTs from msv_ tokens", () => {
    expect(looksLikeJwt(jwt(valid()))).toBe(true);
    expect(looksLikeJwt(`msv_${"a".repeat(43)}`)).toBe(false);
  });
});

describe("AuthMiddleware with an Aegis token", () => {
  const saved = { issuer: process.env.AEGIS_ISSUER, appUrl: process.env.APP_URL };

  beforeEach(() => {
    process.env.AEGIS_ISSUER = ISSUER;
    process.env.APP_URL = env.APP_URL;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.AEGIS_ISSUER = saved.issuer;
    process.env.APP_URL = saved.appUrl;
  });

  function setup() {
    const users = {
      byId: vi.fn(async (id: string) => (id === ALICE.id ? ALICE : null)),
      idForAegisSub: vi.fn(async (sub: string) => (sub === ALICE_SUB ? ALICE.id : null)),
      signIn: vi.fn(),
    } as any;
    const apiTokens = { userIdFor: vi.fn() } as any;
    return { users, middleware: new AuthMiddleware(users, apiTokens) };
  }

  async function call(middleware: AuthMiddleware, method: string, path: string, token: string) {
    let status = 200;
    let ranAs: RequestUser | undefined | null = null;
    const res = { status: (s: number) => ((status = s), res), json: () => res } as any;
    await middleware.use({ method, originalUrl: path, headers: { authorization: `Bearer ${token}` } } as any, res, () => {
      ranAs = currentUser();
    });
    return { status, ranAs: ranAs as RequestUser | null };
  }

  it("runs a read as the account the Aegis subject signs in to", async () => {
    const { middleware } = setup();
    const result = await call(middleware, "GET", "/api/v1/search?query=x", jwt(valid()));
    expect(result).toMatchObject({ status: 200, ranAs: { id: ALICE.id, via: "aegis" } });
  });

  it("refuses writes and other routes before verifying anything", async () => {
    const { users, middleware } = setup();
    expect(await call(middleware, "POST", "/api/v1/search", jwt(valid()))).toMatchObject({ status: 403, ranAs: null });
    expect(await call(middleware, "GET", "/api/v1/admin/users", jwt(valid()))).toMatchObject({ status: 403, ranAs: null });
    expect(await call(middleware, "GET", "/api/v1/api-tokens", jwt(valid()))).toMatchObject({ status: 403, ranAs: null });
    expect(users.idForAegisSub).not.toHaveBeenCalled();
  });

  it("refuses an invalid token, and someone who has never used Missive", async () => {
    const { middleware } = setup();
    expect(await call(middleware, "GET", "/api/v1/me", jwt(valid({ aud: "https://other.example.com" })))).toMatchObject({ status: 401, ranAs: null });
    expect(await call(middleware, "GET", "/api/v1/me", jwt(valid({ sub: "stranger" })))).toMatchObject({ status: 401, ranAs: null });
  });
});
