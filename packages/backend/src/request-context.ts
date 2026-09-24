import { AsyncLocalStorage } from "node:async_hooks";

/** Who the current request (or background job) is acting for. */
export type RequestUser = { id: string; email: string; name?: string };

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
