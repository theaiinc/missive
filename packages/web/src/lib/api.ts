/** A failed API call, with the HTTP status (0: no answer at all). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * An API reply's data. An error reply (JSON too: `{ error }`) throws instead
 * of standing in for the data: used as a list or an object, it crashed the
 * page that read it ("folders.find is not a function").
 */
export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok) throw new ApiError(body?.message ?? body?.error ?? `${url} failed (${res.status})`, res.status);
  return body as T;
}

/**
 * A deploy restarts the API, which answers 5xx for a few minutes meanwhile:
 * loads keep trying for about a minute and a half before showing the error.
 * Other failures (gone, not yours, signed out) don't retry.
 */
export const retryServerErrors = (failures: number, error: unknown) =>
  failures < 8 && (!(error instanceof ApiError) || error.status >= 500);
export const retryDelay = (failures: number) => Math.min(2000 * 2 ** failures, 15_000);
