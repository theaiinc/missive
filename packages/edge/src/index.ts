import { Container } from "@cloudflare/containers";

// One API instance: it runs the sync scheduler, which must not run twice.
const INSTANCE = "api";
const API_PORT = 4000;

export interface Env {
  API: DurableObjectNamespace<MissiveApi>;
  ASSETS: Fetcher;
  EMAIL: SendEmail;
  INBOUND: R2Bucket;
  APP_URL: string;
  AEGIS_ISSUER: string;
  AEGIS_CLIENT_ID: string;
  MISSIVE_ORGANIZER?: string;
  // Secrets
  DATABASE_URL: string;
  SESSION_SECRET: string;
  AEGIS_CLIENT_SECRET: string;
  /** The Worker proves itself to the API with this when it hands over mail. */
  INBOUND_SECRET: string;
  /** The API proves itself to the Worker with this when it sends mail. */
  EDGE_SECRET: string;
  /** Optional: OAuth apps for connecting Gmail / Outlook accounts (Settings). Redirect: APP_URL/oauth. */
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  OUTLOOK_CLIENT_ID?: string;
  OUTLOOK_CLIENT_SECRET?: string;
  OUTLOOK_TENANT?: string;
}

/** The Missive API (Dockerfile.backend). Its settings come from this Worker's vars and secrets. */
export class MissiveApi extends Container<Env> {
  defaultPort = API_PORT;
  // Long enough that someone reading mail doesn't wait for a cold start
  // between clicks; incoming mail wakes it up again.
  sleepAfter = "30m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      NODE_ENV: "production",
      PORT: String(API_PORT),
      DATABASE_URL: env.DATABASE_URL,
      APP_URL: env.APP_URL,
      CORS_ORIGIN: env.APP_URL,
      AEGIS_ISSUER: env.AEGIS_ISSUER,
      AEGIS_CLIENT_ID: env.AEGIS_CLIENT_ID,
      AEGIS_CLIENT_SECRET: env.AEGIS_CLIENT_SECRET,
      SESSION_SECRET: env.SESSION_SECRET,
      INBOUND_SECRET: env.INBOUND_SECRET,
      EDGE_URL: env.APP_URL,
      EDGE_SECRET: env.EDGE_SECRET,
      MISSIVE_ORGANIZER: env.MISSIVE_ORGANIZER ?? "",
      GMAIL_CLIENT_ID: env.GMAIL_CLIENT_ID ?? "",
      GMAIL_CLIENT_SECRET: env.GMAIL_CLIENT_SECRET ?? "",
      OUTLOOK_CLIENT_ID: env.OUTLOOK_CLIENT_ID ?? "",
      OUTLOOK_CLIENT_SECRET: env.OUTLOOK_CLIENT_SECRET ?? "",
      OUTLOOK_TENANT: env.OUTLOOK_TENANT ?? "",
    };
  }
}

const api = (env: Env) => env.API.getByName(INSTANCE);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function bearerMatches(request: Request, secret: string | undefined): boolean {
  const header = request.headers.get("authorization") ?? "";
  if (!secret || secret.length < 32 || !header.startsWith("Bearer ")) return false;
  const given = new TextEncoder().encode(header.slice(7));
  const expected = new TextEncoder().encode(secret);
  if (given.byteLength !== expected.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < given.byteLength; i++) diff |= given[i]! ^ expected[i]!;
  return diff === 0;
}

type SendRequest = {
  from: { email: string; name?: string };
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
};

/**
 * Sends one message for the API. The API has already checked that the
 * signed-in person owns the From mailbox; this only checks it's the API asking.
 */
async function send(request: Request, env: Env): Promise<Response> {
  if (!bearerMatches(request, env.EDGE_SECRET)) return json({ error: "Not allowed" }, 401);
  const mail = (await request.json()) as SendRequest;
  try {
    const result = await env.EMAIL.send({
      from: mail.from.name ? { email: mail.from.email, name: mail.from.name } : mail.from.email,
      to: mail.to,
      ...(mail.cc?.length ? { cc: mail.cc } : {}),
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      ...(mail.headers && Object.keys(mail.headers).length ? { headers: mail.headers } : {}),
    });
    return json({ messageId: result.messageId });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/send" && request.method === "POST") return send(request, env);
    if (url.pathname.startsWith("/internal/")) return json({ error: "Not found" }, 404);
    // /api/* and /auth/* go to the API; everything else is the web app
    // (run_worker_first in wrangler.jsonc sends only these paths here).
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return api(env).fetch(request);
    return env.ASSETS.fetch(request);
  },

  /**
   * Mail for a hosted mailbox (Email Routing sends it here). It's kept in R2
   * first, then handed to the API, which files it for the mailbox's owner.
   */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = await new Response(message.raw).arrayBuffer();
    const key = `inbound/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.eml`;
    await env.INBOUND.put(key, raw, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: { to: message.to.toLowerCase(), from: message.from.toLowerCase() },
    });
    const response = await api(env).fetch(
      new Request(`${env.APP_URL}/api/v1/inbound`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.INBOUND_SECRET}`,
          "content-type": "message/rfc822",
          "x-envelope-to": message.to,
          "x-envelope-from": message.from,
        },
        body: raw,
      })
    );
    if (response.status === 404) {
      message.setReject("No such mailbox");
      await env.INBOUND.delete(key);
      return;
    }
    // Anything else is our problem, not the sender's: the copy stays in R2
    // (key in the log) and the error makes Email Routing report a failure.
    if (!response.ok) throw new Error(`API refused mail for ${message.to} (${response.status}); kept as ${key}`);
  },
} satisfies ExportedHandler<Env>;
