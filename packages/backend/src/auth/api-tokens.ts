import { BadRequestException, Body, Controller, Delete, Get, Injectable, NotFoundException, Param, Post } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { CreateApiTokenRequestSchema, type ApiToken, type CreatedApiToken } from "@theaiinc/missive-core";
import { PostgresService } from "../storage/postgres.service";
import { requireSessionUser } from "../request-context";

/**
 * Personal API tokens let another app (Simasis) call the API as a user,
 * server to server: `Authorization: Bearer msv_<43 base64url chars>`. Only
 * the SHA-256 of a token is stored; the token is shown once, when created.
 */
export const TOKEN_PREFIX = "msv_";
const DISPLAY_CHARS = 8;
/** last_used_at is written at most this often per token. */
const TOUCH_EVERY_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const generateApiToken = () => `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
export const hashApiToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const displayPrefix = (token: string) => token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + DISPLAY_CHARS);
/** Shaped like a token we issue (so random bearer values never reach the database). */
export const looksLikeApiToken = (value: string) => /^msv_[A-Za-z0-9_-]{43}$/.test(value);

const rowToToken = (r: any): ApiToken => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  createdAt: new Date(r.created_at).toISOString(),
  lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
});

@Injectable()
export class ApiTokensService {
  private readonly touched = new Map<string, number>();

  constructor(private readonly pg: PostgresService) {}

  /** The current user's live tokens (row-level security keeps it to theirs). */
  async list(): Promise<ApiToken[]> {
    const { rows } = await this.pg.query(
      `SELECT id, name, prefix, created_at, last_used_at FROM api_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC`,
    );
    return rows.map(rowToToken);
  }

  /** Creates a token for the current user; the only time the token itself is returned. */
  async create(name: string): Promise<CreatedApiToken> {
    const token = generateApiToken();
    const { rows } = await this.pg.query(
      `INSERT INTO api_tokens (name, token_hash, prefix) VALUES ($1, $2, $3) RETURNING id, name, prefix, created_at`,
      [name, hashApiToken(token), displayPrefix(token)],
    );
    const { lastUsedAt: _, ...created } = rowToToken(rows[0]);
    return { ...created, token };
  }

  /** Revokes one of the current user's tokens; false if they have no such live token. */
  async revoke(id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const { rowCount } = await this.pg.query(`UPDATE api_tokens SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`, [id]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Who a bearer token belongs to, or null (unknown, revoked, or malformed).
   * Runs before anyone is signed in, so it reads as the server (systemQuery):
   * the table's row-level security isn't forced for that reason.
   */
  async userIdFor(token: string): Promise<string | null> {
    if (!looksLikeApiToken(token)) return null;
    const { rows } = await this.pg.systemQuery(
      `SELECT id, user_id FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashApiToken(token)],
    );
    const row = rows[0];
    if (!row) return null;
    this.touch(row.id);
    return row.user_id;
  }

  /** Best effort and off the request path: records use at most once a minute per token. */
  private touch(id: string) {
    const now = Date.now();
    if (now - (this.touched.get(id) ?? 0) < TOUCH_EVERY_MS) return;
    if (this.touched.size > 1000) this.touched.clear();
    this.touched.set(id, now);
    this.pg
      .systemQuery(`UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1`, [id])
      .catch((e: Error) => console.error(`[api-tokens] couldn't record use: ${e.message}`));
  }
}

/** Token management: signed-in session only, never with an API token. */
@Controller("api/v1/api-tokens")
export class ApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  @Get()
  async list(): Promise<ApiToken[]> {
    requireSessionUser();
    return this.tokens.list();
  }

  @Post()
  async create(@Body() body: unknown): Promise<CreatedApiToken> {
    requireSessionUser();
    const parsed = CreateApiTokenRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException("A name of 1 to 100 characters is required");
    return this.tokens.create(parsed.data.name);
  }

  @Delete(":id")
  async revoke(@Param("id") id: string): Promise<{ revoked: true }> {
    requireSessionUser();
    if (!(await this.tokens.revoke(id))) throw new NotFoundException("No such token");
    return { revoked: true };
  }
}
