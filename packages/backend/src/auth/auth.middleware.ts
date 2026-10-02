import { Injectable, NestMiddleware } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import { runAsUser, type RequestUser } from "../request-context";
import { UsersService } from "../users.service";
import { SESSION_COOKIE, readCookie, unseal, type Session } from "./session";
import { ApiTokensService, TOKEN_PREFIX } from "./api-tokens";

/** Routes that don't need a signed-in user (they check their own credentials). */
const PUBLIC = [/^\/auth\//, /^\/api\/v1\/health$/, /^\/api\/v1\/inbound$/];

/** Never with a personal API token: managing the tokens themselves, and administration. */
const SESSION_ONLY = [/^\/api\/v1\/api-tokens(\/|$)/i, /^\/api\/v1\/admin(\/|$)/i];

const SIGN_IN_REQUIRED = { error: "Sign in required", signIn: "/auth/login" };

/**
 * Every other request needs an Aegis session and runs as that user, which is
 * what scopes its database queries (see PostgresService.query).
 *
 * Or a personal API token (`Authorization: Bearer msv_...`, see api-tokens.ts)
 * for another app calling on the user's behalf: it runs as the token's owner
 * exactly like their session would, except on SESSION_ONLY routes. An unknown
 * or revoked token is refused even if a session cookie came along too.
 *
 * Local development only: with NODE_ENV not "production", MISSIVE_DEV_USER_EMAIL
 * signs every request in as that email, so the app runs without Aegis.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  private devUser?: Promise<RequestUser>;
  /** The cookie holds only the user id; email and name come from the database, briefly cached. */
  private readonly cache = new Map<string, { user: RequestUser | null; at: number }>();

  constructor(
    private readonly users: UsersService,
    private readonly apiTokens: ApiTokensService,
  ) {}

  private async userFor(id: string): Promise<RequestUser | null> {
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < 60_000) return hit.user;
    const user = await this.users.byId(id);
    if (this.cache.size > 1000) this.cache.clear();
    this.cache.set(id, { user, at: Date.now() });
    return user;
  }

  async use(req: Request, res: Response, next: NextFunction) {
    const path = req.originalUrl.split("?")[0] ?? "";
    if (PUBLIC.some((p) => p.test(path))) return next();
    // Creating an invitation with the admin token (scripts); the console uses an admin session instead.
    if (path === "/api/v1/admin/mailbox-invites" && req.headers.authorization?.startsWith("Bearer ")) return next();

    const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
    if (bearer?.startsWith(TOKEN_PREFIX)) {
      if (SESSION_ONLY.some((p) => p.test(path))) {
        res.status(403).json({ error: "Not available with an API token" });
        return;
      }
      const userId = await this.apiTokens.userIdFor(bearer);
      const owner = userId ? await this.userFor(userId) : null;
      if (!owner) {
        res.status(401).json(SIGN_IN_REQUIRED);
        return;
      }
      return runAsUser({ ...owner, via: "token" }, () => next());
    }

    const session = unseal<Session>(readCookie(req.headers.cookie, SESSION_COOKIE));
    let user: RequestUser | null = session ? await this.userFor(session.userId) : null;

    const devEmail = process.env.MISSIVE_DEV_USER_EMAIL;
    if (!user && devEmail && process.env.NODE_ENV !== "production") {
      this.devUser ??= this.users.signIn(`dev:${devEmail}`, devEmail, "Local developer");
      user = await this.devUser;
    }
    if (!user) {
      res.status(401).json(SIGN_IN_REQUIRED);
      return;
    }
    runAsUser({ ...user, via: "session" }, () => next());
  }
}
