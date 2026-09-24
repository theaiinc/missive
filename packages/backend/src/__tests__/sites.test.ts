import { describe, expect, it } from "vitest";
import { secretEnvName, siteFor } from "../auth/sites";

const env = {
  APP_URL: "https://missive.theaiinc.com",
  AEGIS_CLIENT_ID: "missive",
  AEGIS_CLIENT_SECRET: "main-secret",
  MISSIVE_SITES: "mail.bugmole.com=bugmole-mail, bad host=x",
  AEGIS_CLIENT_SECRET_BUGMOLE_MAIL: "bugmole-secret",
} as NodeJS.ProcessEnv;
const req = (host?: string) => ({ headers: host === undefined ? {} : { "x-missive-host": host } });

describe("siteFor", () => {
  it("uses the main client when no site header is set", () => {
    expect(siteFor(req(), env)).toMatchObject({ clientId: "missive", clientSecret: "main-secret", appUrl: "https://missive.theaiinc.com" });
  });

  it("uses a configured site's own client, secret and address", () => {
    expect(siteFor(req("MAIL.bugmole.com"), env)).toEqual({
      host: "mail.bugmole.com",
      appUrl: "https://mail.bugmole.com",
      clientId: "bugmole-mail",
      clientSecret: "bugmole-secret",
    });
  });

  it("falls back to the main site for a host that isn't configured", () => {
    expect(siteFor(req("evil.example.com"), env).clientId).toBe("missive");
    expect(siteFor(req("bad host"), env).clientId).toBe("missive");
  });

  it("names each client's secret from its id", () => {
    expect(secretEnvName("bugmole-mail")).toBe("AEGIS_CLIENT_SECRET_BUGMOLE_MAIL");
  });
});
