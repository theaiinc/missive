import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ChatAppsService } from "../../chat-apps.service";
import { WecomCrypto } from "../wecom-crypto";
import { runAsUser } from "../../request-context";
import type { StoredConnector } from "../../connector.store";
import type { WecomCredentials, ZaloCredentials } from "../hook-providers";

const owner = { id: "f70c55df-0000-0000-0000-000000000000", email: "steve@theaiinc.com", name: "Steve" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const wecomCreds: WecomCredentials = {
  corpId: "ww1234567890",
  secret: "app-secret",
  agentId: "1000002",
  token: "QDG6eKtoken0000000000000000000000",
  aesKey: "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C",
  hookKey: "wecom-hook-key",
};
const zaloCreds: ZaloCredentials = {
  appId: "4321",
  appSecret: "zalo-app-secret",
  oaSecretKey: "oa-secret",
  oaId: "999",
  refreshToken: "refresh-1",
  accessToken: "access-1",
  accessTokenUntil: Date.now() + 3_600_000,
  hookKey: "zalo-hook-key",
};

function setup() {
  const connectors = new Map<string, StoredConnector>([
    ["wecom:x", { id: "wecom:x", provider: "wecom", label: "Acme WeCom", email: "ww1234567890/1000002", tokens: { ...wecomCreds }, connectedAt: "2026-11-13T00:00:00Z" }],
    ["zalo:x", { id: "zalo:x", provider: "zalo", label: "Acme OA", email: "999", tokens: { ...zaloCreds }, connectedAt: "2026-11-13T00:00:00Z" }],
  ]);
  const hooks = new Map([
    [sha("wecom-hook-key"), { owner_id: owner.id, connector_id: "wecom:x", provider: "wecom" }],
    [sha("zalo-hook-key"), { owner_id: owner.id, connector_id: "zalo:x", provider: "zalo" }],
  ]);
  const missives = new Map<string, any>();
  const threads = new Map<string, any>();
  const store = {
    get: async (id: string) => connectors.get(id),
    getByEmail: async (p: string, e: string) => [...connectors.values()].find((c) => c.provider === p && c.email === e),
    list: async (p: string) => [...connectors.values()].filter((c) => c.provider === p),
    save: async (p: string, d: any) => {
      const c = { ...d, id: `${p}:x` };
      connectors.set(c.id, c);
      return c;
    },
    markNeedsReauth: vi.fn(),
  };
  const storage = {
    missiveExists: async (id: string) => missives.has(id),
    saveMissive: async (m: any) => void missives.set(m.id, m),
    getThread: async (id: string) => threads.get(id) ?? null,
    saveThread: async (t: any) => void threads.set(t.id, { ...t, missiveIds: [...t.missiveIds] }),
    getThreadMissives: async (id: string) => [...missives.values()].filter((m) => m.threadId === id).sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)),
  };
  const users = { byId: async (id: string) => (id === owner.id ? owner : null), all: async () => [owner] };
  const pg = {
    systemQuery: async (_sql: string, [hash, provider]: string[]) => {
      const row = hooks.get(hash!);
      return { rows: row && row.provider === provider ? [row] : [] };
    },
    query: async () => ({ rows: [] }),
  };
  const events = { emit: vi.fn() };
  const service = new ChatAppsService(store as never, storage as never, users as never, events as never, pg as never);
  return { service, missives, threads, events, connectors };
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const reply = (json: unknown) => Promise.resolve(new Response(JSON.stringify(json)));

function wecomPost(xml: string) {
  const box = new WecomCrypto(wecomCreds.token, wecomCreds.aesKey, wecomCreds.corpId);
  const encrypted = box.encrypt(xml);
  const timestamp = "1700000000";
  const nonce = "abc";
  return {
    method: "POST",
    query: { msg_signature: box.signature(timestamp, nonce, encrypted), timestamp, nonce },
    body: `<xml><ToUserName><![CDATA[${wecomCreds.corpId}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
  };
}

describe("WeCom webhook", () => {
  it("answers WeCom's URL check with the decrypted echostr", async () => {
    const { service } = setup();
    const box = new WecomCrypto(wecomCreds.token, wecomCreds.aesKey, wecomCreds.corpId);
    const echostr = box.encrypt("1616140317555161061");
    const res = await service.hook("wecom", "wecom-hook-key", {
      method: "GET",
      query: { msg_signature: box.signature("1", "2", echostr), timestamp: "1", nonce: "2", echostr },
      body: "",
    });
    expect(res).toEqual({ status: 200, body: "1616140317555161061" });
  });

  it("files a member's message to the app as the owner's chat, under the member's name", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes("gettoken") ? reply({ errcode: 0, access_token: "t", expires_in: 7200 }) : reply({ errcode: 0, name: "Zhang San" }),
    );
    const { service, missives, events } = setup();
    const res = await service.hook("wecom", "wecom-hook-key", wecomPost(
      "<xml><ToUserName><![CDATA[ww1234567890]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content><MsgId>7001</MsgId><AgentID>1000002</AgentID></xml>",
    ));
    expect(res).toEqual({ status: 200, body: "success" });
    const [m] = [...missives.values()];
    expect(m).toMatchObject({ channel: "chat", folder: "chat", provider: "wecom", direction: "inbound", body: "你好", from: { name: "Zhang San" }, status: "unread" });
    expect(events.emit).toHaveBeenCalledWith("missive.received", expect.anything());
  });

  it("refuses a forged callback and an unknown key", async () => {
    const { service, missives } = setup();
    const post = wecomPost("<xml><MsgType>text</MsgType></xml>");
    post.query.msg_signature = "0".repeat(40);
    expect((await service.hook("wecom", "wecom-hook-key", post)).status).toBe(403);
    expect((await service.hook("wecom", "nope", wecomPost("<xml/>"))).status).toBe(404);
    expect((await service.hook("zalo", "wecom-hook-key", wecomPost("<xml/>"))).status).toBe(404);
    expect(missives.size).toBe(0);
  });

  it("reads WeChat Customer Service messages after the callback and keeps the cursor", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("gettoken")) return reply({ errcode: 0, access_token: "t", expires_in: 7200 });
      if (url.includes("kf/sync_msg")) {
        return reply({
          errcode: 0,
          next_cursor: "c2",
          has_more: 0,
          msg_list: [
            { msgid: "k1", open_kfid: "wkA", external_userid: "wmU", send_time: 1700000000, origin: 3, msgtype: "text", text: { content: "Is this in stock?" } },
            { msgid: "k2", open_kfid: "wkA", send_time: 1700000001, origin: 4, msgtype: "event" },
          ],
        });
      }
      if (url.includes("kf/customer/batchget")) return reply({ errcode: 0, customer_list: [{ external_userid: "wmU", nickname: "Li Wei" }] });
      return reply({ errcode: 0 });
    });
    const { service, missives, connectors } = setup();
    await service.hook("wecom", "wecom-hook-key", wecomPost(
      "<xml><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[ENC123]]></Token><OpenKfId><![CDATA[wkA]]></OpenKfId></xml>",
    ));
    await vi.waitFor(() => expect((connectors.get("wecom:x")!.tokens as WecomCredentials).kfCursors).toEqual({ wkA: "c2" }));
    const filed = [...missives.values()];
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ body: "Is this in stock?", from: { name: "Li Wei" }, subject: "Li Wei" });
  });

  it("sends a reply to a Customer Service chat through kf/send_msg", async () => {
    const sent: any[] = [];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("gettoken")) return reply({ errcode: 0, access_token: "t", expires_in: 7200 });
      if (url.includes("kf/send_msg")) {
        sent.push(JSON.parse(String(init!.body)));
        return reply({ errcode: 0, msgid: "out1" });
      }
      return reply({ errcode: 0, msg_list: [{ msgid: "k1", open_kfid: "wkA", external_userid: "wmU", send_time: 1700000000, origin: 3, msgtype: "text", text: { content: "hi" } }] });
    });
    const { service, missives } = setup();
    await service.hook("wecom", "wecom-hook-key", wecomPost("<xml><MsgType>event</MsgType><Event>kf_msg_or_event</Event><Token>T</Token><OpenKfId>wkA</OpenKfId></xml>"));
    await vi.waitFor(() => expect(missives.size).toBe(1));
    const threadId = [...missives.values()][0].threadId;
    const out = await runAsUser(owner as never, () => service.send(threadId, "Yes, it is"));
    expect(sent).toEqual([{ touser: "wmU", open_kfid: "wkA", msgtype: "text", text: { content: "Yes, it is" } }]);
    expect(out).toMatchObject({ direction: "outbound", body: "Yes, it is", status: "read" });
  });
});

describe("Zalo webhook", () => {
  const zaloBody = (event: object) => {
    const raw = JSON.stringify(event);
    const ts = String((event as any).timestamp);
    return { raw, signature: "mac=" + sha(`${zaloCreds.appId}${raw}${ts}${zaloCreds.oaSecretKey}`) };
  };
  const userText = { app_id: "4321", event_name: "user_send_text", timestamp: "1700000000000", sender: { id: "u77" }, recipient: { id: "999" }, message: { msg_id: "z1", text: "Xin chào" } };

  it("files a follower's message under their Zalo name", async () => {
    fetchMock.mockImplementation(() => reply({ error: 0, data: { display_name: "Nguyễn An" } }));
    const { service, missives } = setup();
    const { raw, signature } = zaloBody(userText);
    expect(await service.hook("zalo", "zalo-hook-key", { method: "POST", query: {}, body: raw, signature })).toEqual({ status: 200, body: "ok" });
    await service.settled();
    expect([...missives.values()][0]).toMatchObject({ provider: "zalo", body: "Xin chào", from: { name: "Nguyễn An", address: "zalo:u77" }, direction: "inbound" });
  });

  it("refuses a body that doesn't match its signature", async () => {
    const { service, missives } = setup();
    const { signature } = zaloBody(userText);
    const res = await service.hook("zalo", "zalo-hook-key", { method: "POST", query: {}, body: JSON.stringify({ ...userText, message: { msg_id: "z1", text: "forged" } }), signature });
    expect(res.status).toBe(403);
    expect(missives.size).toBe(0);
  });

  it("refreshes an expired token once, stores the new pair, then replies", async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation((url: string) => {
      calls.push(url);
      if (url.includes("access_token")) return reply({ access_token: "access-2", refresh_token: "refresh-2", expires_in: "90000" });
      if (url.includes("message/cs")) return reply({ error: 0, data: { message_id: "zo1" } });
      return reply({ error: 0, data: { display_name: "An" } });
    });
    const { service, missives, connectors } = setup();
    (connectors.get("zalo:x")!.tokens as ZaloCredentials).accessTokenUntil = 0;
    const { raw, signature } = zaloBody(userText);
    await service.hook("zalo", "zalo-hook-key", { method: "POST", query: {}, body: raw, signature });
    await service.settled();
    const out = await runAsUser(owner as never, () => service.send([...missives.values()][0].threadId, "Cảm ơn bạn"));
    expect(out).toMatchObject({ direction: "outbound", body: "Cảm ơn bạn" });
    expect(calls.filter((u) => u.includes("access_token"))).toHaveLength(1);
    expect(connectors.get("zalo:x")!.tokens).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });
});

describe("Zalo connect through the OA admin's Allow", () => {
  it("trades the code for tokens, files nothing until the OA Secret Key is added, then files messages", async () => {
    process.env.APP_URL = "https://missive.theaiinc.com";
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/v4/oa/access_token")) {
        expect(String(init!.body)).toContain("grant_type=authorization_code");
        return reply({ access_token: "acc", refresh_token: "ref", expires_in: "90000" });
      }
      if (url.includes("/oa/getoa")) return reply({ error: 0, data: { oa_id: "555", name: "Acme OA" } });
      return reply({ error: 0, data: { display_name: "An" } });
    });
    const { service, missives, connectors } = setup();
    const { url } = await runAsUser(owner as never, async () => service.zaloAuthorize("4321", "zalo-app-secret", ""));
    const permission = new URL(url);
    expect(permission.origin + permission.pathname).toBe("https://oauth.zaloapp.com/v4/oa/permission");
    expect(permission.searchParams.get("redirect_uri")).toBe("https://missive.theaiinc.com/api/v1/chat-apps/zalo/callback");
    const state = permission.searchParams.get("state")!;

    // Someone else's session can't finish it; a wrong state is refused.
    const intruder = { ...owner, id: "00000000-0000-0000-0000-000000000001" };
    expect(await runAsUser(intruder as never, () => service.zaloCallback("code", state))).toContain("chat_error");

    const { url: url2 } = await runAsUser(owner as never, async () => service.zaloAuthorize("4321", "zalo-app-secret", ""));
    const state2 = new URL(url2).searchParams.get("state")!;
    expect(await runAsUser(owner as never, () => service.zaloCallback("code", state2))).toBe("/settings?chat_connected=zalo#chat-apps");
    const connector = [...connectors.values()].find((c) => c.email === "555")!;
    const creds = connector.tokens as ZaloCredentials;
    expect(creds).toMatchObject({ appId: "4321", oaId: "555", refreshToken: "ref", accessToken: "acc", oaSecretKey: "" });
    expect(connector.label).toBe("Acme OA");

    // The state can't be used twice.
    expect(await runAsUser(owner as never, () => service.zaloCallback("code", state2))).toContain("chat_error");
  });

  it("answers but files nothing while the OA Secret Key is missing", async () => {
    const { service, missives, connectors } = setup();
    (connectors.get("zalo:x")!.tokens as ZaloCredentials).oaSecretKey = "";
    const res = await service.hook("zalo", "zalo-hook-key", { method: "POST", query: {}, body: '{"event_name":"user_send_text"}' });
    expect(res).toEqual({ status: 200, body: "ok" });
    expect(missives.size).toBe(0);

    await runAsUser(owner as never, () => service.setZaloSecret("zalo:x", "oa-secret"));
    fetchMock.mockImplementation(() => reply({ error: 0, data: { display_name: "An" } }));
    const event = { app_id: "4321", event_name: "user_send_text", timestamp: "1700000000000", sender: { id: "u1" }, recipient: { id: "999" }, message: { msg_id: "m9", text: "hi" } };
    const raw = JSON.stringify(event);
    const signature = "mac=" + sha(`4321${raw}1700000000000oa-secret`);
    expect((await service.hook("zalo", "zalo-hook-key", { method: "POST", query: {}, body: raw, signature })).status).toBe(200);
    await service.settled();
    expect(missives.size).toBe(1);
  });
});

describe("Zalo's 2-second limit", () => {
  it("answers before the name lookup finishes", async () => {
    let release!: () => void;
    fetchMock.mockImplementation(() => new Promise((r) => (release = () => r(reply({ error: 0, data: { display_name: "Slow" } }) as never))).then((x) => x));
    const { service, missives, connectors } = setup();
    (connectors.get("zalo:x")!.tokens as ZaloCredentials).oaName = "Acme OA";
    const event = { app_id: "4321", event_name: "user_send_text", timestamp: "1700000000000", sender: { id: "u5" }, recipient: { id: "999" }, message: { msg_id: "s1", text: "quick" } };
    const raw = JSON.stringify(event);
    const signature = "mac=" + sha(`4321${raw}1700000000000oa-secret`);
    expect(await service.hook("zalo", "zalo-hook-key", { method: "POST", query: {}, body: raw, signature })).toEqual({ status: 200, body: "ok" });
    expect(missives.size).toBe(0);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(missives.size).toBe(0);
    release();
    await service.settled();
    expect([...missives.values()][0]).toMatchObject({ body: "quick", from: { name: "Slow" } });
  });
});

describe("readable Zalo names", () => {
  it("labels a sender Zalo won't name, and shows the OA's name instead of its id", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes("getoa") ? reply({ error: 0, data: { oa_id: "999", name: "Neko Coffee" } }) : reply({ error: 0, data: { display_name: "5387598391981684897" } }),
    );
    const { service, missives, connectors } = setup();
    const event = { app_id: "4321", event_name: "user_send_text", timestamp: "1700000000000", sender: { id: "5387598391981684897" }, recipient: { id: "999" }, message: { msg_id: "n1", text: "hello" } };
    const raw = JSON.stringify(event);
    await service.hook("zalo", "zalo-hook-key", { method: "POST", query: {}, body: raw, signature: "mac=" + sha(`4321${raw}1700000000000oa-secret`) });
    await service.settled();
    expect([...missives.values()][0]).toMatchObject({ from: { name: "Zalo user ···4897" }, subject: "Zalo user ···4897" });
    expect((connectors.get("zalo:x")!.tokens as ZaloCredentials).oaName).toBe("Neko Coffee");
    const accounts = await runAsUser(owner as never, () => service.accounts());
    expect(accounts.find((a) => a.provider === "zalo")!.displayHandle).toBe("Neko Coffee");
  });
});
