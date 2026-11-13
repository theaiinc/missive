import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Zalo Official Account API: webhook events in (users messaging the OA) and
 * customer-service text replies out (v3 /oa/message/cs). The OA access token
 * lasts ~25 hours; each refresh returns a new refresh token (valid ~3 months)
 * and spends the old one, so the caller must store the new one every time.
 * https://developers.zalo.me/docs/official-account
 */
const OAUTH = "https://oauth.zaloapp.com/v4/oa";
const OPENAPI = "https://openapi.zalo.me";

export interface ZaloTokens {
  accessToken?: string;
  /** When accessToken stops working (ms since epoch). */
  accessTokenUntil?: number;
  refreshToken: string;
}

export class ZaloError extends Error {
  constructor(readonly code: number, message: string) {
    super(`Zalo error ${code}: ${message}`);
    this.name = "ZaloError";
  }
}

/** The event body Zalo POSTs to the webhook. */
export interface ZaloEvent {
  app_id: string;
  event_name: string;
  timestamp: string;
  sender?: { id: string };
  recipient?: { id: string };
  user_id_by_app?: string;
  message?: { msg_id: string; text?: string };
}

/**
 * Zalo signs each webhook call: X-ZEvent-Signature is
 * "mac=" + sha256(appId + raw body + timestamp + OA secret key).
 */
export function verifyZaloSignature(
  header: string | undefined,
  appId: string,
  rawBody: string,
  timestamp: string,
  oaSecretKey: string,
): boolean {
  const expected = Buffer.from(`mac=${createHash("sha256").update(`${appId}${rawBody}${timestamp}${oaSecretKey}`).digest("hex")}`);
  const given = Buffer.from(String(header ?? ""));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export class ZaloApi {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Spends `refreshToken` for a new access token and a new refresh token. */
  async refresh(refreshToken: string): Promise<ZaloTokens> {
    const res = await this.fetchFn(`${OAUTH}/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", secret_key: this.appSecret },
      body: new URLSearchParams({ refresh_token: refreshToken, app_id: this.appId, grant_type: "refresh_token" }),
    });
    const json: any = await res.json();
    if (!json.access_token) throw new ZaloError(Number(json.error ?? -1), json.error_description ?? json.message ?? "token refresh refused");
    return {
      accessToken: json.access_token,
      accessTokenUntil: Date.now() + (Number(json.expires_in ?? 90000) - 300) * 1000,
      refreshToken: json.refresh_token ?? refreshToken,
    };
  }

  private async call(accessToken: string, path: string, body?: unknown): Promise<any> {
    const res = await this.fetchFn(`${OPENAPI}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { access_token: accessToken, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json: any = await res.json();
    if (json.error) throw new ZaloError(Number(json.error), json.message ?? "request refused");
    return json;
  }

  /** The OA's own name and id, to label the connection. */
  async oaInfo(accessToken: string): Promise<{ oaId: string; name: string }> {
    const json = await this.call(accessToken, "/v2.0/oa/getoa");
    return { oaId: String(json.data?.oa_id ?? ""), name: json.data?.name ?? "Zalo OA" };
  }

  /** A follower's display name, if Zalo shares it. */
  async userName(accessToken: string, userId: string): Promise<string | undefined> {
    try {
      const json = await this.call(accessToken, `/v3.0/oa/user/detail?data=${encodeURIComponent(JSON.stringify({ user_id: userId }))}`);
      return json.data?.display_name || undefined;
    } catch {
      return undefined;
    }
  }

  /** A customer-service text reply (allowed within Zalo's window after the user's last message). */
  async sendText(accessToken: string, userId: string, text: string): Promise<string | undefined> {
    const json = await this.call(accessToken, "/v3.0/oa/message/cs", {
      recipient: { user_id: userId },
      message: { text },
    });
    return json.data?.message_id;
  }
}
