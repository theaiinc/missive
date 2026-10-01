/**
 * Mail relay for a Missive domain whose zone is in another Cloudflare account
 * (octopusai.live: its website and sign-in run there, so the zone stays).
 * Email Routing only hands mail to Workers in the zone's own account, and
 * Email Sending only sends for that account's domains, so this Worker,
 * deployed there, carries the domain's mail both ways:
 *
 *  - in:  Email Routing catch-all → email() → Missive's /internal/inbound
 *  - out: Missive's edge (SEND_RELAYS) → POST /send → Email Sending
 *
 * Both directions prove themselves with RELAY_SECRET (the same secret on both Workers).
 */

interface Env {
  EMAIL: SendEmail;
  /** Missive's edge Worker, e.g. https://missive.theaiinc.com */
  MISSIVE_URL: string;
  /** Where mail for addresses that aren't Missive mailboxes or groups goes (an Email Routing–verified address). */
  FORWARD_UNKNOWN?: string;
  RELAY_SECRET: string;
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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/send" || request.method !== "POST") return json({ error: "Not found" }, 404);
    if (!bearerMatches(request, env.RELAY_SECRET)) return json({ error: "Not allowed" }, 401);
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
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = await new Response(message.raw).arrayBuffer();
    const response = await fetch(`${env.MISSIVE_URL}/internal/inbound`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RELAY_SECRET}`,
        "content-type": "message/rfc822",
        "x-envelope-to": message.to,
        "x-envelope-from": message.from,
      },
      body: raw,
    });
    if (response.status === 404) {
      if (env.FORWARD_UNKNOWN) await message.forward(env.FORWARD_UNKNOWN);
      else message.setReject("No such mailbox");
      return;
    }
    // Throwing makes Email Routing report a temporary failure, so the sender retries.
    if (!response.ok) throw new Error(`Missive refused the mail (${response.status})`);
  },
} satisfies ExportedHandler<Env>;
