import { Container } from "@cloudflare/containers";
// Bundled from source (the Worker has no build step for core); same format as the backend.
import { DataCipher } from "../../core/src/crypto";
import { AI_MODEL, aiUsage, chatCompletions, type AiEnv } from "./ai";

export { AiBudget } from "./ai";

// One API instance: it runs the sync scheduler, which must not run twice.
const INSTANCE = "api";
const API_PORT = 4000;

export interface Env extends AiEnv {
  CF_VERSION_METADATA: WorkerVersionMetadata;
  API: DurableObjectNamespace<MissiveApi>;
  ASSETS: Fetcher;
  EMAIL: SendEmail;
  INBOUND: R2Bucket;
  APP_URL: string;
  AEGIS_ISSUER: string;
  AEGIS_CLIENT_ID: string;
  /** More addresses Missive is served at, "host=clientId,…" (backend auth/sites.ts). */
  MISSIVE_SITES?: string;
  MISSIVE_ORG_NAMES?: string;
  /**
   * "domain=address,…": mail for a domain's addresses that aren't Missive
   * mailboxes is forwarded to that (Email Routing–verified) address instead
   * of being rejected, so Missive can take a domain's catch-all.
   */
  FORWARD_UNKNOWN?: string;
  MISSIVE_ORGANIZER?: string;
  /** The organizer only files mail received from this time on (ISO date). */
  ORGANIZER_SINCE?: string;
  // Secrets
  DATABASE_URL: string;
  SESSION_SECRET: string;
  AEGIS_CLIENT_SECRET: string;
  /** The Worker proves itself to the API with this when it hands over mail. */
  INBOUND_SECRET: string;
  /** Master key for email data at rest (see core/src/crypto.ts). */
  MISSIVE_DATA_KEY: string;
  /** Bearer token for the admin API (mailbox invitations). */
  ADMIN_TOKEN?: string;
  /** The API proves itself to the Worker with this when it sends mail. */
  EDGE_SECRET: string;
  /** Optional: OAuth apps for connecting Gmail / Outlook accounts (Settings). Redirect: APP_URL/oauth. */
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  OUTLOOK_CLIENT_ID?: string;
  OUTLOOK_CLIENT_SECRET?: string;
  OUTLOOK_TENANT?: string;
  /** Optional: the Google Calendar OAuth app (read-only calendars), separate from Gmail's. Redirect: APP_URL/oauth. */
  GCAL_CLIENT_ID?: string;
  GCAL_CLIENT_SECRET?: string;
  /** Secrets for the MISSIVE_SITES clients: AEGIS_CLIENT_SECRET_<CLIENT_ID>. */
  [secret: `AEGIS_CLIENT_SECRET_${string}`]: string | undefined;
}

/** The backend reads which address a request came in on from this (auth/sites.ts). */
const SITE_HEADER = "x-missive-host";

/** The AEGIS_CLIENT_SECRET_<CLIENT_ID> secrets, for the container. */
function siteSecrets(env: Env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[0].startsWith("AEGIS_CLIENT_SECRET_") && typeof entry[1] === "string"
    )
  );
}

/** Where FORWARD_UNKNOWN sends a domain's unknown recipients, if anywhere. */
export function forwardFor(forwardUnknown: string | undefined, recipient: string): string | null {
  const domain = recipient.slice(recipient.lastIndexOf("@") + 1).toLowerCase();
  for (const pair of (forwardUnknown ?? "").split(",")) {
    const [d, to] = pair.split("=").map((s) => s?.trim());
    if (d && to && d.toLowerCase() === domain) return to;
  }
  return null;
}

/** The Missive API (Dockerfile.backend). Its settings come from this Worker's vars and secrets. */
export class MissiveApi extends Container<Env> {
  defaultPort = API_PORT;
  // Long enough that someone reading mail doesn't wait for a cold start
  // between clicks; incoming mail wakes it up again.
  sleepAfter = "30m";

  /**
   * Which deploy started the running container. A deploy updates this
   * Worker at once, but the container keeps its old image until it stops,
   * and the cron below keeps it awake, so without this a deploy's API changes
   * never went live (a database fix shipped but the old queries kept running).
   */
  override async onStart(): Promise<void> {
    await this.ctx.storage.put("startedByVersion", (this.env as Env).CF_VERSION_METADATA.id);
  }

  /** Stops a container started by an older deploy; the next request starts the new image. */
  async restartIfStale(currentVersion: string): Promise<boolean> {
    const startedBy = await this.ctx.storage.get<string>("startedByVersion");
    if (startedBy === currentVersion) return false;
    if ((await this.getState()).status !== "healthy" && startedBy !== undefined) return false;
    await this.ctx.storage.put("startedByVersion", currentVersion);
    await this.stop();
    return true;
  }

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
      MISSIVE_SITES: env.MISSIVE_SITES ?? "",
      MISSIVE_ORG_NAMES: env.MISSIVE_ORG_NAMES ?? "",
      ...siteSecrets(env),
      SESSION_SECRET: env.SESSION_SECRET,
      INBOUND_SECRET: env.INBOUND_SECRET,
      MISSIVE_DATA_KEY: env.MISSIVE_DATA_KEY,
      ADMIN_TOKEN: env.ADMIN_TOKEN ?? "",
      EDGE_URL: env.APP_URL,
      EDGE_SECRET: env.EDGE_SECRET,
      MISSIVE_ORGANIZER: env.MISSIVE_ORGANIZER ?? "",
      // The organizer and chat assistant use Workers AI through this Worker (ai.ts).
      LM_STUDIO_BASE_URL: `${env.APP_URL}/internal/ai/v1`,
      LM_STUDIO_MODEL: AI_MODEL,
      LLM_API_KEY: env.EDGE_SECRET,
      ORGANIZER_SINCE: env.ORGANIZER_SINCE ?? "",
      // Connected Gmail/Outlook/IMAP accounts sync every 5 minutes (kept awake by the cron below).
      // Every minute checked each account's 50 newest messages 1,440 times a day, which (with
      // whole rows fetched per check) used up the database's free transfer quota in two days.
      AUTO_SYNC_INTERVAL_MS: "300000",
      GMAIL_CLIENT_ID: env.GMAIL_CLIENT_ID ?? "",
      GMAIL_CLIENT_SECRET: env.GMAIL_CLIENT_SECRET ?? "",
      OUTLOOK_CLIENT_ID: env.OUTLOOK_CLIENT_ID ?? "",
      OUTLOOK_CLIENT_SECRET: env.OUTLOOK_CLIENT_SECRET ?? "",
      OUTLOOK_TENANT: env.OUTLOOK_TENANT ?? "",
      GCAL_CLIENT_ID: env.GCAL_CLIENT_ID ?? "",
      GCAL_CLIENT_SECRET: env.GCAL_CLIENT_SECRET ?? "",
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
  /**
   * Every minute (wrangler.jsonc triggers): keeps the API container awake, so
   * its scheduler keeps syncing connected accounts. Asleep, nothing syncs
   * until someone opens the app, and new Gmail mail shows up late.
   */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await api(env).restartIfStale(env.CF_VERSION_METADATA.id);
    await api(env).fetch(new Request(`${env.APP_URL}/api/v1/health`));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/send" && request.method === "POST") return send(request, env);
    if (url.pathname.startsWith("/internal/ai/")) {
      if (!bearerMatches(request, env.EDGE_SECRET)) return json({ error: "Not allowed" }, 401);
      if (url.pathname === "/internal/ai/v1/chat/completions" && request.method === "POST") return chatCompletions(request, env);
      if (url.pathname === "/internal/ai/usage" && request.method === "GET") return aiUsage(env);
    }
    if (url.pathname.startsWith("/internal/")) return json({ error: "Not found" }, 404);
    // /api/* and /auth/* go to the API; everything else is the web app
    // (run_worker_first in wrangler.jsonc sends only these paths here).
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      // Set here, never taken from the browser: it picks the Aegis client.
      const forwarded = new Request(request);
      forwarded.headers.set(SITE_HEADER, url.host);
      return api(env).fetch(forwarded);
    }
    return env.ASSETS.fetch(request);
  },

  /**
   * Mail for a hosted mailbox (Email Routing sends it here). It's kept in R2
   * first, then handed to the API, which files it for the mailbox's owner.
   */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = await new Response(message.raw).arrayBuffer();
    const key = `inbound/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.eml`;
    // Stored encrypted, bound to its key, with no addresses in the metadata.
    // Throws (and Email Routing retries later) if the key isn't configured,
    // rather than ever writing mail in the clear.
    const sealed = await DataCipher.fromSecret(env.MISSIVE_DATA_KEY).encryptBytes("system:inbound", key, raw);
    await env.INBOUND.put(key, sealed, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { encryption: "mv1", scope: "system:inbound" },
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
      await env.INBOUND.delete(key);
      const forwardTo = forwardFor(env.FORWARD_UNKNOWN, message.to);
      if (forwardTo) await message.forward(forwardTo);
      else message.setReject("No such mailbox");
      return;
    }
    // Anything else is our problem, not the sender's: the copy stays in R2
    // (key in the log) and the error makes Email Routing report a failure.
    if (!response.ok) throw new Error(`API refused inbound mail (${response.status}); kept encrypted as ${key}`);
  },
} satisfies ExportedHandler<Env>;
