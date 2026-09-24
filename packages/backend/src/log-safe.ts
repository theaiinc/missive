/**
 * Logging that never carries email data: addresses are masked, and errors are
 * reduced to their type, status and message (never request/response bodies,
 * headers or config, which provider errors carry).
 */
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function redact(text: string): string {
  return text.replace(EMAIL, "[email]");
}

export function safeError(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; status?: unknown; response?: { status?: unknown } };
    const code = e.code ?? e.status ?? e.response?.status;
    return redact(`${e.name}${code ? ` (${String(code)})` : ""}: ${e.message}`).slice(0, 500);
  }
  return redact(String(err)).slice(0, 500);
}
