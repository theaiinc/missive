import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ApiTokenGrantController, arcanaCallback, callbackUrl } from "../auth/api-token-grant";
import { ApiTokensService, looksLikeApiToken } from "../auth/api-tokens";
import { AuthMiddleware } from "../auth/auth.middleware";
import { aegisTokenAllowed } from "../auth/aegis-bearer";
import { seal } from "../auth/session";
import { runAsUser, type RequestUser } from "../request-context";

const ALICE: RequestUser = { id: "11111111-1111-4111-8111-111111111111", email: "alice@example.com", name: "Alice" };
const BOB: RequestUser = { id: "22222222-2222-4222-8222-222222222222", email: "bob@example.com", name: "Bob" };
const CALLBACK = "http://127.0.0.1:51824/callback";
const STATE = "abcdefghijklmnopqrstuvwxyz012345";

const asSession = <T>(fn: () => T, user = ALICE) => runAsUser({ ...user, via: "session" }, fn);

beforeEach(() => {
  process.env.SESSION_SECRET = "x".repeat(40);
});

function setup() {
  const created: { name: string; userId: string }[] = [];
  const service = {
    create: vi.fn(async (name: string) => {
      const { requireUser } = await import("../request-context");
      created.push({ name, userId: requireUser().id });
      return { id: "t1", name, prefix: "abcdefgh", createdAt: new Date().toISOString(), token: `msv_${"A".repeat(43)}` };
    }),
  } as unknown as ApiTokensService;
  return { controller: new ApiTokenGrantController(service), created, service };
}

/** A fake express response that records what the page sent. */
function fakeRes() {
  const out = { status: 200, body: "", headers: {} as Record<string, string>, redirect: "" };
  const res: any = {
    setHeader: (k: string, v: string) => ((out.headers[k.toLowerCase()] = v), res),
    status: (s: number) => ((out.status = s), res),
    type: () => res,
    send: (b: string) => ((out.body = b), res),
    json: (b: unknown) => ((out.body = JSON.stringify(b)), res),
    redirect: (s: number, url: string) => ((out.status = s), (out.redirect = url), res),
  };
  return { res, out };
}

/** The sealed grant the page hands its Allow button. */
const grantFrom = (html: string) => JSON.parse(/grant: ("[^"]+")/.exec(html)![1]!) as string;

describe("arcanaCallback", () => {
  it("accepts only Arcana's loopback listener", () => {
    expect(arcanaCallback(CALLBACK)).toBe(CALLBACK);
    for (const bad of [
      "http://127.0.0.1:51822/callback", // another port (Simasis's)
      "http://127.0.0.1:8080/callback",
      "http://localhost:51824/callback",
      "https://127.0.0.1:51824/callback",
      "http://127.0.0.1:51824/other",
      "http://127.0.0.1:51824/callback?x=1",
      "http://127.0.0.1:51824@evil.example/callback",
      "http://evil.example/callback",
      "//127.0.0.1:51824/callback",
      undefined,
      42,
    ]) {
      expect(arcanaCallback(bad), String(bad)).toBeNull();
    }
  });

  it("puts the token and the state in the fragment", () => {
    expect(callbackUrl(CALLBACK, STATE, { token: "msv_x" })).toBe(`${CALLBACK}?state=${STATE}#token=msv_x&state=${STATE}`);
    expect(callbackUrl(CALLBACK, STATE, { error: "access_denied" })).toBe(`${CALLBACK}?state=${STATE}#error=access_denied&state=${STATE}`);
  });
});

describe("GET /api/v1/api-tokens/grant", () => {
  it("asks the signed-in person, naming the app, the token and the account", () => {
    const { controller } = setup();
    const { res, out } = fakeRes();
    asSession(() => controller.ask(res, CALLBACK, STATE, "Arcana", "Arcana on my Mac"));
    expect(out.status).toBe(200);
    expect(out.body).toContain("Allow Arcana to use your Missive account?");
    expect(out.body).toContain("<b>Arcana on my Mac</b>");
    expect(out.body).toContain("alice@example.com");
    expect(out.body).toContain(`href="${CALLBACK}?state=${STATE}#error=access_denied&#38;state=${STATE}"`);
    expect(out.headers["cache-control"]).toBe("no-store");
    expect(out.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(out.body).not.toContain("msv_");
  });

  it("refuses a callback that isn't Arcana's, a bad state or a bad name, without asking", () => {
    const { controller } = setup();
    for (const [callback, state, name] of [
      ["https://evil.example/callback", STATE, "Arcana"],
      ["http://127.0.0.1:9999/callback", STATE, "Arcana"],
      [CALLBACK, "short", "Arcana"],
      [CALLBACK, undefined, "Arcana"],
      [CALLBACK, STATE, "x".repeat(101)],
    ] as const) {
      const { res, out } = fakeRes();
      asSession(() => controller.ask(res, callback, state, "Arcana", name));
      expect(out.status, `${callback} ${state}`).toBe(400);
      expect(out.body).not.toContain("grant:");
    }
  });

  it("escapes what the request names", () => {
    const { controller } = setup();
    const { res, out } = fakeRes();
    asSession(() => controller.ask(res, CALLBACK, STATE, "<script>", "<img src=x>"));
    expect(out.body).not.toContain("<img src=x>");
    expect(out.body).toContain("&#60;img src=x&#62;");
    expect(out.body).toContain("Allow Arcana"); // an app name outside the allowed characters falls back
  });

  it("refuses an API token or an Aegis token", () => {
    const { controller } = setup();
    for (const via of ["token", "aegis"] as const) {
      const { res } = fakeRes();
      expect(() => runAsUser({ ...ALICE, via }, () => controller.ask(res, CALLBACK, STATE, "Arcana", "Arcana"))).toThrow(ForbiddenException);
    }
  });
});

describe("POST /api/v1/api-tokens/grant (Allow)", () => {
  const page = (controller: ApiTokenGrantController, name = "Arcana") => {
    const { res, out } = fakeRes();
    asSession(() => controller.ask(res, CALLBACK, STATE, "Arcana", name));
    return grantFrom(out.body);
  };
  const sameOrigin = { headers: { "sec-fetch-site": "same-origin" } } as any;

  it("creates a token with the given name for the person and sends it to the callback's fragment", async () => {
    const { controller, created } = setup();
    const grant = page(controller, "Arcana laptop");
    const { redirect } = await asSession(() => controller.allow(sameOrigin, { grant }));
    expect(created).toEqual([{ name: "Arcana laptop", userId: ALICE.id }]);
    const url = new URL(redirect);
    expect(`${url.origin}${url.pathname}`).toBe(CALLBACK);
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.search).not.toContain("msv_");
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(looksLikeApiToken(fragment.get("token")!)).toBe(true);
    expect(fragment.get("state")).toBe(STATE);
  });

  it("refuses someone else's grant, a forged or expired one, and a cross-site request", async () => {
    const { controller, created } = setup();
    const grant = page(controller);
    await expect(asSession(() => controller.allow(sameOrigin, { grant }), BOB)).rejects.toBeInstanceOf(BadRequestException);
    await expect(asSession(() => controller.allow(sameOrigin, { grant: grant + "x" }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(asSession(() => controller.allow(sameOrigin, {}))).rejects.toBeInstanceOf(BadRequestException);
    const expired = seal({ purpose: "api-token-grant", userId: ALICE.id, callback: CALLBACK, state: STATE, name: "Arcana", exp: Date.now() - 1 });
    await expect(asSession(() => controller.allow(sameOrigin, { grant: expired }))).rejects.toBeInstanceOf(BadRequestException);
    const otherCallback = seal({ purpose: "api-token-grant", userId: ALICE.id, callback: "http://evil.example/callback", state: STATE, name: "Arcana", exp: Date.now() + 60_000 });
    await expect(asSession(() => controller.allow(sameOrigin, { grant: otherCallback }))).rejects.toBeInstanceOf(BadRequestException);
    // A session cookie is signed by the same key but isn't a grant.
    const session = seal({ userId: ALICE.id, exp: Date.now() + 60_000 });
    await expect(asSession(() => controller.allow(sameOrigin, { grant: session }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(asSession(() => controller.allow({ headers: { "sec-fetch-site": "cross-site" } } as any, { grant }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(created).toEqual([]);
  });

  it("refuses an API token or an Aegis token", async () => {
    const { controller, created } = setup();
    const grant = page(controller);
    for (const via of ["token", "aegis"] as const) {
      await expect(runAsUser({ ...ALICE, via }, () => controller.allow(sameOrigin, { grant }))).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(created).toEqual([]);
  });
});

describe("AuthMiddleware on the grant page", () => {
  const middleware = () =>
    new AuthMiddleware({ byId: vi.fn(async () => null), signIn: vi.fn() } as any, { userIdFor: vi.fn(async () => null) } as any);

  it("sends a signed-out browser to sign in and back", async () => {
    const { res, out } = fakeRes();
    const url = `/api/v1/api-tokens/grant?callback=${encodeURIComponent(CALLBACK)}&state=${STATE}&app=Arcana`;
    await middleware().use({ method: "GET", originalUrl: url, headers: {} } as any, res, () => {
      throw new Error("must not run signed out");
    });
    expect(out.status).toBe(302);
    expect(out.redirect).toBe(`/auth/login?returnTo=${encodeURIComponent(url)}`);
  });

  it("answers the Allow POST and other API routes with the usual 401", async () => {
    for (const [method, path] of [["POST", "/api/v1/api-tokens/grant"], ["GET", "/api/v1/api-tokens"]]) {
      const { res, out } = fakeRes();
      await middleware().use({ method, originalUrl: path, headers: {} } as any, res, () => {
        throw new Error("must not run signed out");
      });
      expect(out.status, `${method} ${path}`).toBe(401);
    }
  });

  it("refuses an API token on the grant routes", async () => {
    const { res, out } = fakeRes();
    await middleware().use({ method: "GET", originalUrl: "/api/v1/api-tokens/grant", headers: { authorization: `Bearer msv_${"A".repeat(43)}` } } as any, res, () => {
      throw new Error("must not run with a token");
    });
    expect(out.status).toBe(403);
  });

  it("is not on the Aegis token allowlist", () => {
    expect(aegisTokenAllowed("GET", "/api/v1/api-tokens/grant")).toBe(false);
    expect(aegisTokenAllowed("POST", "/api/v1/api-tokens/grant")).toBe(false);
  });
});
