import { describe, expect, it, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { ApiTokensController, ApiTokensService, generateApiToken, hashApiToken } from "../auth/api-tokens";
import { AuthMiddleware } from "../auth/auth.middleware";
import { currentUser, runAsUser, type RequestUser } from "../request-context";

const ALICE: RequestUser = { id: "11111111-1111-4111-8111-111111111111", email: "alice@example.com", name: "Alice" };

type Row = { id: string; user_id: string; name: string; token_hash: string; prefix: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null };

/**
 * A tiny in-memory api_tokens table. `query` is the row-level-security path
 * (scoped to the current user, like PostgresService.query); `systemQuery`
 * sees every row, like the owner role does.
 */
function fakePg() {
  const rows: Row[] = [];
  const sql: string[] = [];
  let n = 0;
  const run = (scoped: boolean) =>
    vi.fn(async (text: string, params: any[] = []) => {
      sql.push(text);
      const mine = (r: Row) => !scoped || r.user_id === currentUser()?.id;
      if (text.startsWith("INSERT INTO api_tokens")) {
        const row: Row = {
          id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, user_id: currentUser()!.id, name: params[0],
          token_hash: params[1], prefix: params[2], created_at: new Date(), last_used_at: null, revoked_at: null,
        };
        rows.push(row);
        return { rows: [{ id: row.id, name: row.name, prefix: row.prefix, created_at: row.created_at }], rowCount: 1 };
      }
      if (text.startsWith("SELECT id, name, prefix, created_at, last_used_at FROM api_tokens")) {
        return { rows: rows.filter((r) => mine(r) && !r.revoked_at).map(({ id, name, prefix, created_at, last_used_at }) => ({ id, name, prefix, created_at, last_used_at })) };
      }
      if (text.startsWith("UPDATE api_tokens SET revoked_at")) {
        const hit = rows.filter((r) => mine(r) && r.id === params[0] && !r.revoked_at);
        hit.forEach((r) => (r.revoked_at = new Date()));
        return { rows: [], rowCount: hit.length };
      }
      if (text.startsWith("SELECT id, user_id FROM api_tokens WHERE token_hash")) {
        return { rows: rows.filter((r) => mine(r) && r.token_hash === params[0] && !r.revoked_at).map(({ id, user_id }) => ({ id, user_id })) };
      }
      if (text.startsWith("UPDATE api_tokens SET last_used_at")) {
        rows.filter((r) => r.id === params[0]).forEach((r) => (r.last_used_at = new Date()));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text}`);
    });
  return { pg: { query: run(true), systemQuery: run(false) } as any, rows, sql };
}

function setup() {
  const db = fakePg();
  const service = new ApiTokensService(db.pg);
  const users = { byId: vi.fn(async (id: string) => (id === ALICE.id ? ALICE : null)), signIn: vi.fn() } as any;
  const middleware = new AuthMiddleware(users, service);
  return { db, service, middleware, controller: new ApiTokensController(service) };
}

/** Runs the middleware; resolves with who `next` ran as, or the response it sent instead. */
async function call(middleware: AuthMiddleware, path: string, headers: Record<string, string>) {
  let status = 200;
  let body: unknown;
  let ranAs: RequestUser | undefined | null = null;
  const res = { status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) } as any;
  await middleware.use({ originalUrl: path, headers } as any, res, () => {
    ranAs = currentUser();
  });
  return { status, body, ranAs: ranAs as RequestUser | null };
}

const asSession = <T>(fn: () => T) => runAsUser({ ...ALICE, via: "session" }, fn);

describe("token format", () => {
  it("is msv_ followed by 32 random bytes in base64url", () => {
    const token = generateApiToken();
    expect(token).toMatch(/^msv_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token.slice(4), "base64url")).toHaveLength(32);
    expect(generateApiToken()).not.toBe(token);
  });

  it("hashes to hex sha256 of the whole token", () => {
    const token = generateApiToken();
    expect(hashApiToken(token)).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hashApiToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ApiTokensService", () => {
  it("stores only the hash and a short prefix, and returns the token once", async () => {
    const { db, service } = setup();
    const created = await asSession(() => service.create("Simasis"));
    expect(created.token).toMatch(/^msv_/);
    expect(created.prefix).toBe(created.token.slice(4, 12));
    const [row] = db.rows;
    expect(row!.token_hash).toBe(hashApiToken(created.token));
    expect(JSON.stringify(db.rows)).not.toContain(created.token);
    expect(JSON.stringify(db.rows)).not.toContain(created.token.slice(4));
  });

  it("lists without the token or its hash", async () => {
    const { db, service } = setup();
    const created = await asSession(() => service.create("Simasis"));
    const list = await asSession(() => service.list());
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]!).sort()).toEqual(["createdAt", "id", "lastUsedAt", "name", "prefix"]);
    const text = JSON.stringify(list);
    expect(text).not.toContain(created.token);
    expect(text).not.toContain(db.rows[0]!.token_hash);
  });

  it("revokes only live tokens and drops them from the list", async () => {
    const { service } = setup();
    const created = await asSession(() => service.create("Simasis"));
    expect(await asSession(() => service.revoke(created.id))).toBe(true);
    expect(await asSession(() => service.revoke(created.id))).toBe(false);
    expect(await asSession(() => service.revoke("not-a-uuid"))).toBe(false);
    expect(await asSession(() => service.list())).toEqual([]);
  });
});

describe("AuthMiddleware with an API token", () => {
  it("runs a valid token's request as its owner", async () => {
    const { service, middleware } = setup();
    const { token } = await asSession(() => service.create("Simasis"));
    const result = await call(middleware, "/api/v1/search?query=x", { authorization: `Bearer ${token}` });
    expect(result.status).toBe(200);
    expect(result.ranAs).toMatchObject({ id: ALICE.id, email: ALICE.email, via: "token" });
  });

  it("records use at most once a minute", async () => {
    const { db, service, middleware } = setup();
    const { token } = await asSession(() => service.create("Simasis"));
    await call(middleware, "/api/v1/me", { authorization: `Bearer ${token}` });
    await call(middleware, "/api/v1/me", { authorization: `Bearer ${token}` });
    expect(db.sql.filter((s) => s.startsWith("UPDATE api_tokens SET last_used_at"))).toHaveLength(1);
    expect(db.rows[0]!.last_used_at).not.toBeNull();
  });

  it("refuses an unknown token with the usual 401, even with a session cookie", async () => {
    const { middleware } = setup();
    const result = await call(middleware, "/api/v1/search", { authorization: `Bearer ${generateApiToken()}`, cookie: "missive_session=x.y" });
    expect(result).toMatchObject({ status: 401, body: { error: "Sign in required", signIn: "/auth/login" }, ranAs: null });
  });

  it("refuses malformed tokens without touching the database", async () => {
    const { db, middleware } = setup();
    const result = await call(middleware, "/api/v1/search", { authorization: "Bearer msv_short" });
    expect(result.status).toBe(401);
    expect(db.sql).toEqual([]);
  });

  it("refuses a revoked token", async () => {
    const { service, middleware } = setup();
    const created = await asSession(() => service.create("Simasis"));
    await asSession(() => service.revoke(created.id));
    const result = await call(middleware, "/api/v1/search", { authorization: `Bearer ${created.token}` });
    expect(result).toMatchObject({ status: 401, ranAs: null });
  });

  it("refuses token management and admin routes", async () => {
    const { service, middleware } = setup();
    const { token } = await asSession(() => service.create("Simasis"));
    for (const path of ["/api/v1/api-tokens", "/api/v1/api-tokens/abc", "/API/V1/API-TOKENS", "/api/v1/admin/users"]) {
      const result = await call(middleware, path, { authorization: `Bearer ${token}` });
      expect(result, path).toMatchObject({ status: 403, ranAs: null });
    }
  });

  it("leaves public routes alone", async () => {
    const { middleware } = setup();
    const result = await call(middleware, "/api/v1/health", { authorization: `Bearer ${generateApiToken()}` });
    expect(result.status).toBe(200);
  });
});

describe("ApiTokensController", () => {
  it("refuses every call made with an API token", async () => {
    const { controller } = setup();
    const asToken = <T>(fn: () => T) => runAsUser({ ...ALICE, via: "token" }, fn);
    await expect(asToken(() => controller.list())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(asToken(() => controller.create({ name: "x" }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(asToken(() => controller.revoke("00000000-0000-4000-8000-000000000001"))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("validates the name", async () => {
    const { controller } = setup();
    await expect(asSession(() => controller.create({ name: "" }))).rejects.toThrow();
    await expect(asSession(() => controller.create({ name: "x".repeat(101) }))).rejects.toThrow();
    await expect(asSession(() => controller.create({}))).rejects.toThrow();
    const created = await asSession(() => controller.create({ name: "  Simasis  " }));
    expect(created.name).toBe("Simasis");
  });
});
