import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshSession } from "../auth/refresh";
import { REFRESH_COOKIE, SESSION_COOKIE, decrypt, encrypt, readCookie, unseal, type SavedRefresh, type Session } from "../auth/session";
import type { Site } from "../auth/sites";

const ISSUER = "https://id.example";
const site: Site = { host: "missive.test", appUrl: "https://missive.test", clientId: "missive", clientSecret: "s" };
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };

function idToken(claims: Record<string, unknown>): string {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const head = `${b64({ alg: "RS256", kid: "k1" })}.${b64({ iss: ISSUER, aud: "missive", exp: Math.floor(Date.now() / 1000) + 300, ...claims })}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url")}`;
}

function users() {
  return {
    signIn: vi.fn(async (_sub: string, email: string) => ({ id: "user-1", email, name: null })),
    recordSignIn: vi.fn(async () => undefined),
    setMailboxOffer: vi.fn(async () => undefined),
  };
}

let tokenAnswer: { status: number; body: unknown };
const sent: URLSearchParams[] = [];

beforeEach(() => {
  process.env.SESSION_SECRET = "x".repeat(40);
  process.env.AEGIS_ISSUER = ISSUER;
  sent.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === `${ISSUER}/jwks`) return json(200, { keys: [jwk] });
    if (url === `${ISSUER}/token`) {
      sent.push(new URLSearchParams(String(init?.body)));
      return json(tokenAnswer.status, tokenAnswer.body);
    }
    return json(404, {});
  });
});
afterEach(() => vi.unstubAllGlobals());

const refreshCookie = (saved: Partial<SavedRefresh> = {}) =>
  `${REFRESH_COOKIE}=${encrypt({ token: "rt-1", clientId: "missive", exp: Date.now() + 60_000, ...saved })}`;

describe("staying signed in", () => {
  it("renews the session from the refresh token and keeps Aegis's rights current", async () => {
    tokenAnswer = { status: 200, body: { id_token: idToken({ sub: "aegis-1", email: "a@b.com", email_verified: true, roles: ["ADMIN"] }), refresh_token: "rt-2" } };
    const u = users();
    const result = await refreshSession(refreshCookie(), site, u as never);
    expect(result && !("clear" in result) && result.userId).toBe("user-1");
    expect(sent[0].get("grant_type")).toBe("refresh_token");
    expect(sent[0].get("refresh_token")).toBe("rt-1");
    expect(u.recordSignIn).toHaveBeenCalledWith("user-1", "missive", expect.objectContaining({ roles: ["ADMIN"] }));
    const header = (result && !("clear" in result) ? result.cookies : []).map((c) => c.split(";")[0]).join("; ");
    expect(unseal<Session>(readCookie(header, SESSION_COOKIE))?.userId).toBe("user-1");
    expect(decrypt<SavedRefresh>(readCookie(header, REFRESH_COOKIE))?.token).toBe("rt-2");
  });

  it("encrypts the refresh token", () => {
    expect(refreshCookie()).not.toContain("rt-1");
  });

  it("clears the cookie once Aegis has ended the sign-in", async () => {
    tokenAnswer = { status: 400, body: { error: "invalid_grant" } };
    expect(await refreshSession(refreshCookie(), site, users() as never)).toEqual({ clear: true });
  });

  it("won't use another site's sign-in", async () => {
    tokenAnswer = { status: 200, body: {} };
    expect(await refreshSession(refreshCookie({ clientId: "bugmole-mail" }), site, users() as never)).toEqual({ clear: true });
    expect(sent).toEqual([]);
  });

  it("refuses an unverified email or another app's id_token", async () => {
    tokenAnswer = { status: 200, body: { id_token: idToken({ sub: "s", email: "a@b.com", email_verified: false }) } };
    expect(await refreshSession(refreshCookie(), site, users() as never)).toEqual({ clear: true });
    tokenAnswer = { status: 200, body: { id_token: idToken({ sub: "s", email: "a@b.com", email_verified: true, aud: "other" }) } };
    expect(await refreshSession(refreshCookie(), site, users() as never)).toEqual({ clear: true });
  });

  it("keeps the cookie while Aegis is unavailable", async () => {
    tokenAnswer = { status: 503, body: {} };
    expect(await refreshSession(refreshCookie(), site, users() as never)).toBeNull();
  });
});

describe("a session that runs out mid-page", () => {
  it("is renewed once for all the requests that arrive together", async () => {
    tokenAnswer = { status: 200, body: { id_token: idToken({ sub: "aegis-1", email: "a@b.com", email_verified: true }), refresh_token: "rt-2" } };
    const cookie = refreshCookie();
    const u = users();
    // A rotated token would be refused for every request after the first, and
    // those answers would clear the cookie the first one had just renewed.
    const results = await Promise.all([1, 2, 3].map(() => refreshSession(cookie, site, u as never)));
    expect(sent).toHaveLength(1);
    for (const r of results) expect(r && !("clear" in r) && r.userId).toBe("user-1");
  });

  it("asks Aegis again on the next request when it was unavailable", async () => {
    tokenAnswer = { status: 503, body: {} };
    const cookie = refreshCookie();
    expect(await refreshSession(cookie, site, users() as never)).toBeNull();
    tokenAnswer = { status: 200, body: { id_token: idToken({ sub: "aegis-1", email: "a@b.com", email_verified: true }) } };
    const again = await refreshSession(cookie, site, users() as never);
    expect(sent).toHaveLength(2);
    expect(again && !("clear" in again) && again.userId).toBe("user-1");
  });
});

describe("signing in", () => {
  it("asks Aegis for consent, without which it gives no refresh token", async () => {
    const { AuthController } = await import("../auth/auth.controller");
    const login = (query: Record<string, string>) => {
      let location = "";
      const res = { setHeader: () => undefined, redirect: (_: number, url: string) => void (location = url) };
      new AuthController({} as never, {} as never).login({ headers: {}, query } as never, res as never);
      return new URL(location).searchParams;
    };
    const first = login({});
    expect(first.get("scope")).toContain("offline_access");
    expect(first.get("prompt")).toBe("consent");
    expect(login({ prompt: "login" }).get("prompt")).toBe("login consent");
  });
});
