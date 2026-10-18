import { randomBytes } from "node:crypto";
import { randomToken } from "./session";

/**
 * Signing in to the desktop app (packages/desktop) in the person's own browser.
 *
 * The app's web view can't do passkeys or security keys, so it opens
 * /auth/login?desktop=1 in the default browser instead. When that sign-in
 * finishes, /auth/callback doesn't set the session in the browser: it keeps
 * the new session's cookies here under a one-time code and sends the browser
 * to missive://auth?code=…, which the app catches and turns into
 * /auth/desktop?code=… in its web view; that sets the cookies there.
 *
 * Codes are kept in memory (the API runs as a single instance, see the edge's
 * wrangler.jsonc), work once, and only for a minute.
 */
const CODE_SECONDS = 60;
const codes = new Map<string, { cookies: string[]; exp: number }>();

/** A one-time code for these Set-Cookie values. */
export function mintDesktopCode(cookies: string[]): string {
  const now = Date.now();
  for (const [code, entry] of codes) if (entry.exp <= now) codes.delete(code);
  const code = randomToken();
  codes.set(code, { cookies, exp: now + CODE_SECONDS * 1000 });
  return code;
}

/** The cookies for a code, once; null when it is unknown, used or expired. */
export function redeemDesktopCode(code: unknown): string[] | null {
  if (typeof code !== "string") return null;
  const entry = codes.get(code);
  codes.delete(code);
  return entry && entry.exp > Date.now() ? entry.cookies : null;
}

export const desktopUrl = (code: string) => `missive://auth?code=${encodeURIComponent(code)}`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** What the browser shows while it hands over to the app (and if the hand-off doesn't happen by itself). */
export function returnToAppPage(code: string): { html: string; csp: string } {
  const nonce = randomBytes(16).toString("base64");
  const url = desktopUrl(code);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Return to Missive</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#f7f7f8;--fg:#18181b;--muted:#52525b;--card:#fff;--line:#e4e4e7;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f12;--fg:#f4f4f5;--muted:#a1a1aa;--card:#18181b;--line:#27272a;--accent:#60a5fa}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;max-width:440px;width:100%}
h1{font-size:18px;margin:0 0 12px}p{margin:0 0 12px;color:var(--muted)}
a.btn{display:block;margin-top:16px;padding:10px;border-radius:8px;background:var(--accent);color:#fff;text-align:center;text-decoration:none}
</style></head><body><main>
<h1>You're signed in</h1>
<p>You can return to Missive now and close this tab. If Missive didn't open, use the button (within a minute).</p>
<a class="btn" href="${esc(url)}">Open Missive</a>
</main><script nonce="${nonce}">location.href = ${JSON.stringify(url)};</script></body></html>`;
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`;
  return { html, csp };
}
