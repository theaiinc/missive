/**
 * WeCom server API (qyapi.weixin.qq.com): an access token per app, sending
 * app messages to members, and WeChat Customer Service (微信客服), where
 * external WeChat users chat with the company and replies go through the API.
 * https://developer.work.weixin.qq.com/document/path/90664
 */
const BASE = "https://qyapi.weixin.qq.com/cgi-bin";

export interface WecomConfig {
  corpId: string;
  /** The self-built app's Secret (or the Customer Service secret). */
  secret: string;
  /** The self-built app's AgentId; app messages need it, Customer Service doesn't. */
  agentId?: string;
}

/** One Customer Service message from kf/sync_msg. */
export interface KfMessage {
  msgid: string;
  open_kfid: string;
  external_userid?: string;
  send_time: number;
  /** 3 = from the WeChat user, 4 = system event, 5 = from a servicer. */
  origin: number;
  msgtype: string;
  text?: { content: string };
}

export class WecomError extends Error {
  constructor(readonly errcode: number, errmsg: string) {
    // 60020: the server's IP isn't in the app's trusted IPs (企业可信IP).
    super(errcode === 60020 ? `WeCom refused this server's IP (60020): add it to the app's trusted IPs. ${errmsg}` : `WeCom error ${errcode}: ${errmsg}`);
    this.name = "WecomError";
  }
}

const tokens = new Map<string, { token: string; until: number }>();

export class WecomApi {
  constructor(private readonly config: WecomConfig, private readonly fetchFn: typeof fetch = fetch) {}

  private async call<T = any>(path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.accessToken();
    const url = `${BASE}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
    const res = await this.fetchFn(url, body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json: any = await res.json();
    // 40014 / 42001: token invalid or expired; get a new one once.
    if ((json.errcode === 40014 || json.errcode === 42001) && !retried) {
      tokens.delete(this.cacheKey());
      return this.call(path, body, true);
    }
    if (json.errcode) throw new WecomError(json.errcode, json.errmsg);
    return json;
  }

  private cacheKey(): string {
    return `${this.config.corpId}:${this.config.secret}`;
  }

  async accessToken(): Promise<string> {
    const cached = tokens.get(this.cacheKey());
    if (cached && cached.until > Date.now()) return cached.token;
    const res = await this.fetchFn(
      `${BASE}/gettoken?corpid=${encodeURIComponent(this.config.corpId)}&corpsecret=${encodeURIComponent(this.config.secret)}`,
    );
    const json: any = await res.json();
    if (json.errcode) throw new WecomError(json.errcode, json.errmsg);
    tokens.set(this.cacheKey(), { token: json.access_token, until: Date.now() + (json.expires_in - 300) * 1000 });
    return json.access_token;
  }

  /** A text message from the app to a member. */
  async sendAppText(userId: string, content: string): Promise<string | undefined> {
    const json = await this.call("message/send", {
      touser: userId,
      msgtype: "text",
      agentid: Number(this.config.agentId),
      text: { content },
    });
    return json.msgid;
  }

  /** A member's name; new apps may only get the id back, so callers fall back to it. */
  async memberName(userId: string): Promise<string | undefined> {
    try {
      const json = await this.call(`user/get?userid=${encodeURIComponent(userId)}`);
      return json.name || undefined;
    } catch {
      return undefined;
    }
  }

  /** Customer Service messages after `cursor` (the callback's Token lets this read them). */
  async syncKf(openKfId: string, cursor: string | undefined, callbackToken?: string): Promise<{ messages: KfMessage[]; cursor?: string }> {
    const messages: KfMessage[] = [];
    let next = cursor;
    for (let page = 0; page < 20; page++) {
      const json = await this.call("kf/sync_msg", {
        cursor: next || undefined,
        token: callbackToken || undefined,
        limit: 1000,
        open_kfid: openKfId,
      });
      messages.push(...(json.msg_list ?? []));
      next = json.next_cursor || next;
      if (!json.has_more) break;
    }
    return { messages, cursor: next };
  }

  async sendKfText(openKfId: string, externalUserId: string, content: string): Promise<string | undefined> {
    const json = await this.call("kf/send_msg", {
      touser: externalUserId,
      open_kfid: openKfId,
      msgtype: "text",
      text: { content },
    });
    return json.msgid;
  }

  /** WeChat nicknames of Customer Service users, by external_userid. */
  async kfCustomerNames(externalUserIds: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (externalUserIds.length === 0) return names;
    try {
      const json = await this.call("kf/customer/batchget", { external_userid_list: externalUserIds });
      for (const c of json.customer_list ?? []) if (c.nickname) names.set(c.external_userid, c.nickname);
    } catch {}
    return names;
  }

  /** Checks the corp id and secret by getting a token. */
  async test(): Promise<void> {
    tokens.delete(this.cacheKey());
    await this.accessToken();
  }
}
