import { Injectable, NestMiddleware } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import { runAsUser, type RequestUser } from "../request-context";
import { UsersService } from "../users.service";
import { SESSION_COOKIE, readCookie, unseal, type Session } from "./session";

/** Routes that don't need a signed-in user (they check their own credentials). */
const PUBLIC = [/^\/auth\//, /^\/api\/v1\/health$/, /^\/api\/v1\/inbound$/];

/**
 * Every other request needs an Aegis session and runs as that user, which is
 * what scopes its database queries (see PostgresService.query).
 *
 * Local development only: with NODE_ENV not "production", MISSIVE_DEV_USER_EMAIL
 * signs every request in as that email, so the app runs without Aegis.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  private devUser?: Promise<RequestUser>;
  /** The cookie holds only the user id; email and name come from the database, briefly cached. */
  private readonly cache = new Map<string, { user: RequestUser | null; at: number }>();

  constructor(private readonly users: UsersService) {}

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

    const session = unseal<Session>(readCookie(req.headers.cookie, SESSION_COOKIE));
    let user: RequestUser | null = session ? await this.userFor(session.userId) : null;

    const devEmail = process.env.MISSIVE_DEV_USER_EMAIL;
    if (!user && devEmail && process.env.NODE_ENV !== "production") {
      this.devUser ??= this.users.signIn(`dev:${devEmail}`, devEmail, "Local developer");
      user = await this.devUser;
    }
    if (!user) {
      res.status(401).json({ error: "Sign in required", signIn: "/auth/login" });
      return;
    }
    runAsUser(user, () => next());
  }
}
