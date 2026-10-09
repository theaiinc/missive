import { AsyncLocalStorage } from "node:async_hooks";
import { ForbiddenException } from "@nestjs/common";

/** Who the current request (or background job) is acting for. */
export type RequestUser = {
  id: string;
  email: string;
  name?: string;
  /** How the request signed in: the browser session, a personal API token, or an Aegis access token (see AuthMiddleware). */
  via?: "session" | "token" | "aegis";
};

const storage = new AsyncLocalStorage<RequestUser>();

/** Runs `fn` as `user`: every database query inside it only sees that user's mail. */
export function runAsUser<T>(user: RequestUser, fn: () => T): T {
  return storage.run(user, fn);
}

export function currentUser(): RequestUser | undefined {
  return storage.getStore();
}

export function requireUser(): RequestUser {
  const user = storage.getStore();
  if (!user) throw new Error("No signed-in user for this request");
  return user;
}

/**
 * The signed-in user, only when they signed in with the session cookie: for
 * things an API token must never do, such as managing API tokens.
 */
export function requireSessionUser(): RequestUser {
  const user = requireUser();
  if (user.via === "token" || user.via === "aegis") throw new ForbiddenException("This needs a signed-in session, not an API token");
  return user;
}
