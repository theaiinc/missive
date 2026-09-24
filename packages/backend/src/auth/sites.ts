import type { Request } from "express";

/**
 * The addresses Missive is served at, each signing in with its own Aegis
 * client (and so its own tenant). The main one comes from APP_URL,
 * AEGIS_CLIENT_ID and AEGIS_CLIENT_SECRET.
 *
 * More come from MISSIVE_SITES, comma-separated "host=clientId" pairs, e.g.
 * "mail.bugmole.com=bugmole-mail". Each one's secret is in
 * AEGIS_CLIENT_SECRET_<CLIENT_ID> (upper case, "-" as "_"), and it is served
 * over https at that host.
 */
export type Site = { host: string; appUrl: string; clientId: string; clientSecret: string };

export const SITE_HEADER = "x-missive-host";

export function secretEnvName(clientId: string): string {
  return `AEGIS_CLIENT_SECRET_${clientId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function mainSite(env: NodeJS.ProcessEnv = process.env): Site {
  const appUrl = env.APP_URL ?? "http://localhost:5173";
  return {
    host: new URL(appUrl).host,
    appUrl,
    clientId: env.AEGIS_CLIENT_ID ?? "missive",
    clientSecret: env.AEGIS_CLIENT_SECRET ?? "",
  };
}

export function extraSites(env: NodeJS.ProcessEnv = process.env): Site[] {
  return (env.MISSIVE_SITES ?? "")
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .flatMap((pair) => {
      const [host, clientId] = pair.split("=").map((s) => s?.trim().toLowerCase());
      if (!host || !clientId || !/^[a-z0-9.-]+$/.test(host)) return [];
      return [{ host, appUrl: `https://${host}`, clientId, clientSecret: env[secretEnvName(clientId)] ?? "" }];
    });
}

/**
 * The site a request came in on. The Worker sets x-missive-host from the URL
 * it was called at (replacing anything the browser sent); a host that isn't
 * configured gets the main site, so a forged header can't pick a client.
 */
export function siteFor(req: Pick<Request, "headers">, env: NodeJS.ProcessEnv = process.env): Site {
  const given = req.headers[SITE_HEADER];
  const host = (typeof given === "string" ? given : "").toLowerCase();
  return extraSites(env).find((site) => site.host === host) ?? mainSite(env);
}
