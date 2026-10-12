import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, Query, Req, Res } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { CreateApiTokenRequestSchema } from "@theaiinc/missive-core";
import { ApiTokensService } from "./api-tokens";
import { seal, unseal } from "./session";
import { requireSessionUser } from "../request-context";

/**
 * Handing a personal API token to Arcana on the person's own computer
 * (`arcana secret import-missive-token`) without copying it by hand.
 *
 * Arcana opens
 *   /api/v1/api-tokens/grant?callback=http://127.0.0.1:51824/callback&state=<s>&app=Arcana&name=Arcana
 * the signed-in person clicks Allow, and the browser is sent to the callback
 * with the token in the URL fragment, which browsers never send to a server;
 * Arcana's loopback page there reads it. The same hand-off as Simasis's
 * token-grant page. Guard rails:
 * - the callback must be Arcana's loopback listener, exactly
 *   http://127.0.0.1:<an Arcana port>/callback, so a token never leaves the
 *   computer it was asked from and no other local program gets one;
 * - only a browser session can grant, never an API token or an Aegis token
 *   (the middleware's SESSION_ONLY routes, and requireSessionUser here): a
 *   token can't mint more of itself. Not signed in: the middleware sends the
 *   browser through the normal sign-in and back to this page;
 * - Allow carries a short-lived signed grant bound to the person, the
 *   callback, the state and the token name, and is a same-origin JSON POST
 *   (the session cookie is SameSite=Lax; a cross-site fetch is refused), so
 *   another site can't mint a token on someone's behalf.
 */

/** Arcana's loopback port for Missive (crates/arcana-cli/src/missive.rs in the Arcana repo). */
export const ARCANA_PORTS = [51824];
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
const APP = /^[\p{L}\p{N} ._-]{1,40}$/u;
const DEFAULT_APP = "Arcana";
const GRANT_MINUTES = 10;
const PURPOSE = "api-token-grant";

type Grant = { purpose: string; userId: string; callback: string; state: string; name: string; exp: number };

/** The callback when it is Arcana's own loopback listener, else null. */
export function arcanaCallback(callback: unknown): string | null {
  if (typeof callback !== "string") return null;
  const m = /^http:\/\/127\.0\.0\.1:(\d{2,5})\/callback$/.exec(callback);
  return m && ARCANA_PORTS.includes(Number(m[1])) ? callback : null;
}

export const validState = (state: unknown): state is string => typeof state === "string" && STATE.test(state);

/** Where the browser goes after Allow (a token) or Cancel (an error): the fragment never reaches a server. */
export function callbackUrl(callback: string, state: string, fragment: Record<string, string>): string {
  const s = encodeURIComponent(state);
  const f = new URLSearchParams({ ...fragment, state }).toString();
  return `${callback}?state=${s}#${f}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, nonce = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#f7f7f8;--fg:#18181b;--muted:#52525b;--card:#fff;--line:#e4e4e7;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f12;--fg:#f4f4f5;--muted:#a1a1aa;--card:#18181b;--line:#27272a;--accent:#60a5fa}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;max-width:440px;width:100%}
h1{font-size:18px;margin:0 0 12px}p{margin:0 0 12px;color:var(--muted)}b{color:var(--fg)}
.row{display:flex;gap:8px;margin-top:16px}button,a.btn{flex:1;font:inherit;padding:10px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer;text-align:center;text-decoration:none}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
</style></head><body><main>${body}</main></body></html>`;
}

function noStore(res: Response, nonce: string) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
  );
  res.setHeader("X-Frame-Options", "DENY");
}

@Controller("api/v1/api-tokens/grant")
export class ApiTokenGrantController {
  constructor(private readonly tokens: ApiTokensService) {}

  /** The confirmation page. Signed out, the middleware has already sent the browser to sign in. */
  @Get()
  ask(
    @Res() res: Response,
    @Query("callback") rawCallback?: string,
    @Query("state") state?: string,
    @Query("app") rawApp?: string,
    @Query("name") rawName?: string,
  ): void {
    const nonce = randomBytes(16).toString("base64");
    noStore(res, nonce);
    const callback = arcanaCallback(rawCallback);
    const app = rawApp && APP.test(rawApp) ? rawApp : DEFAULT_APP;
    const name = CreateApiTokenRequestSchema.safeParse({ name: rawName ?? app });
    if (!callback || !validState(state) || !name.success) {
      res.status(400).type("html").send(page("Invalid request", "<h1>This link is not valid</h1><p>Start again from the program that opened it.</p>", nonce));
      return;
    }
    const user = requireSessionUser();
    const grant: Grant = {
      purpose: PURPOSE, userId: user.id, callback, state, name: name.data.name, exp: Date.now() + GRANT_MINUTES * 60_000,
    };
    const port = new URL(callback).port;
    const cancel = callbackUrl(callback, state, { error: "access_denied" });
    // JSON.stringify alone doesn't stop "</script>"; the sealed grant is base64url anyway.
    const grantJs = JSON.stringify(seal(grant)).replace(/</g, "\\u003c");
    res.type("html").send(page(`Allow ${app}?`, `<h1>Allow ${esc(app)} to use your Missive account?</h1>
<p><b>${esc(app)}</b> on this computer (port ${esc(port)}) wants a personal API token named <b>${esc(name.data.name)}</b> for <b>${esc(user.email)}</b>.</p>
<p>It can read and act on your mail as you until you revoke it in Settings &rarr; API tokens. Only allow it if you just started this from ${esc(app)}.</p>
<div class="row"><a class="btn" id="deny" href="${esc(cancel)}">Deny</a><button class="primary" id="allow">Allow</button></div>
<p id="m"></p>
<script nonce="${nonce}">
document.getElementById("allow").onclick = async function () {
  this.disabled = true;
  try {
    const r = await fetch("/api/v1/api-tokens/grant", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ grant: ${grantJs} }) });
    if (!r.ok) throw new Error(String(r.status));
    const { redirect } = await r.json();
    location.replace(redirect);
  } catch (e) {
    this.disabled = false;
    document.getElementById("m").textContent = "That did not work (" + e.message + "). Reload this page and try again.";
  }
};
</script>`, nonce));
  }

  /** Allow: creates the token and answers where to send the browser (the token in the fragment). */
  @Post()
  async allow(@Req() req: Request, @Body() body: unknown): Promise<{ redirect: string }> {
    const user = requireSessionUser();
    // Browsers say where a request came from; only this page's own fetch may allow.
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") throw new ForbiddenException("Not allowed from another site");
    const raw = typeof (body as { grant?: unknown })?.grant === "string" ? (body as { grant: string }).grant : undefined;
    const grant = unseal<Grant>(raw);
    if (!grant) throw new BadRequestException("This request expired. Reload the page and try again.");
    const callback = arcanaCallback(grant.callback);
    const name = CreateApiTokenRequestSchema.safeParse({ name: grant.name });
    if (grant.purpose !== PURPOSE || grant.userId !== user.id || !callback || !validState(grant.state) || !name.success) {
      throw new BadRequestException("Invalid grant");
    }
    const { token } = await this.tokens.create(name.data.name);
    return { redirect: callbackUrl(callback, grant.state, { token }) };
  }
}
