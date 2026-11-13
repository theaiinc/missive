import { randomBytes, randomInt } from "node:crypto";
import type { ChatMessage } from "../chat-bots";
import { WecomApi, WecomError, type KfMessage } from "./wecom-api";
import { WecomCrypto, xmlField } from "./wecom-crypto";
import { ZaloApi, ZaloError, verifyZaloSignature, type ZaloEvent } from "./zalo-api";

/**
 * Chat apps that call Missive instead of being polled: WeCom (企业微信) and
 * Zalo Official Account. Each connection has its own secret webhook URL
 * (/api/v1/hooks/<provider>/<hookKey>); every call is then verified with the
 * connection's own signing secret before anything is filed.
 */
export type HookProvider = "wecom" | "zalo";
export const HOOK_PROVIDERS: HookProvider[] = ["wecom", "zalo"];
export const isHookProvider = (p: string): p is HookProvider => (HOOK_PROVIDERS as string[]).includes(p);

export type WecomCredentials = {
  corpId: string;
  /** The self-built app's Secret. */
  secret: string;
  /** The app's AgentId: messages members send the app, and replies to them. */
  agentId?: string;
  /** Callback Token and EncodingAESKey, made by Missive and pasted into WeCom. */
  token: string;
  aesKey: string;
  /** Where WeChat Customer Service (微信客服) messages were last read up to, per account. */
  kfCursors?: Record<string, string>;
  hookKey: string;
};

export type ZaloCredentials = {
  appId: string;
  appSecret: string;
  /**
   * The OA's secret key (Webhook settings), which signs each webhook call.
   * Empty until it's added: Zalo only shows it once the webhook URL is saved.
   */
  oaSecretKey: string;
  oaId: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenUntil?: number;
  hookKey: string;
};

export type HookCredentials = WecomCredentials | ZaloCredentials;

/** What Settings shows after connecting: where to point the app, and what to paste there. */
export type HookSetup = {
  webhookUrl: string;
  /** Zalo only: the OA Secret Key hasn't been added yet, so webhook calls are answered but not filed. */
  needsSecret?: boolean;
  /** WeCom only: the callback Token and EncodingAESKey to enter in WeCom. */
  token?: string;
  aesKey?: string;
};

export class HookInputError extends Error {}

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const alnum = (n: number) => Array.from({ length: n }, () => ALNUM[randomInt(ALNUM.length)]).join("");
export const newHookKey = () => randomBytes(24).toString("base64url");

export function webhookUrl(appUrl: string, provider: HookProvider, hookKey: string) {
  return `${appUrl.replace(/\/$/, "")}/api/v1/hooks/${provider}/${hookKey}`;
}

/** Placeholder text for what Missive doesn't show yet (images, files, stickers ...). */
const placeholder = (kind: string) => `[${kind || "message"}]`;

// ── WeCom ──────────────────────────────────────────────────

export function wecomApi(c: Pick<WecomCredentials, "corpId" | "secret" | "agentId">, fetchFn?: typeof fetch) {
  return new WecomApi({ corpId: c.corpId, secret: c.secret, agentId: c.agentId }, fetchFn);
}

/** Checks the corp id and secret, and makes the callback Token and EncodingAESKey. */
export async function wecomConnect(
  input: { corpId?: string; secret?: string; agentId?: string },
  fetchFn?: typeof fetch,
): Promise<{ credentials: WecomCredentials; handle: string }> {
  const corpId = input.corpId?.trim();
  const secret = input.secret?.trim();
  const agentId = input.agentId?.trim() || undefined;
  if (!corpId || !secret) throw new HookInputError("Corp ID and the app's Secret are required");
  if (agentId && !/^\d+$/.test(agentId)) throw new HookInputError("AgentId is a number (App Management → your app)");
  try {
    await wecomApi({ corpId, secret }, fetchFn).test();
  } catch (e) {
    throw new HookInputError(e instanceof WecomError ? e.message : `Couldn't reach WeCom: ${String(e)}`);
  }
  return {
    credentials: { corpId, secret, agentId, token: alnum(32), aesKey: alnum(43), hookKey: newHookKey() },
    handle: agentId ? `${corpId}/${agentId}` : corpId,
  };
}

const crypto = (c: WecomCredentials) => new WecomCrypto(c.token, c.aesKey, c.corpId);

/** WeCom's URL check when the callback is saved: the decrypted echostr, or null if it isn't genuine. */
export function wecomVerifyUrl(c: WecomCredentials, q: Record<string, string | undefined>): string | null {
  const { msg_signature, timestamp = "", nonce = "", echostr = "" } = q;
  const box = crypto(c);
  if (!msg_signature || !box.verify(msg_signature, timestamp, nonce, echostr)) return null;
  try {
    return box.decrypt(echostr);
  } catch {
    return null;
  }
}

export type WecomCallback =
  | { kind: "message"; message: ChatMessage }
  /** WeChat Customer Service has new messages: read them with kf/sync_msg. */
  | { kind: "kf"; openKfId: string; token: string }
  | { kind: "ignored" };

/** Verifies and opens one callback POST. Throws if it isn't genuine. */
export function wecomCallback(c: WecomCredentials, q: Record<string, string | undefined>, body: string): WecomCallback {
  const encrypted = xmlField(body, "Encrypt");
  const { msg_signature, timestamp = "", nonce = "" } = q;
  const box = crypto(c);
  if (!encrypted || !msg_signature || !box.verify(msg_signature, timestamp, nonce, encrypted)) {
    throw new HookInputError("Not a genuine WeCom callback");
  }
  const xml = box.decrypt(encrypted);
  const type = xmlField(xml, "MsgType") ?? "";
  if (type === "event") {
    if (xmlField(xml, "Event") === "kf_msg_or_event") {
      return { kind: "kf", openKfId: xmlField(xml, "OpenKfId") ?? "", token: xmlField(xml, "Token") ?? "" };
    }
    return { kind: "ignored" };
  }
  const from = xmlField(xml, "FromUserName") ?? "";
  const msgId = xmlField(xml, "MsgId") ?? `${from}:${xmlField(xml, "CreateTime")}`;
  return {
    kind: "message",
    message: {
      chatId: `app:${from}`,
      chatTitle: from,
      messageId: msgId,
      senderId: from,
      senderName: from,
      text: type === "text" ? xmlField(xml, "Content") ?? "" : placeholder(type),
      fromBot: false,
      at: new Date(Number(xmlField(xml, "CreateTime") ?? 0) * 1000 || Date.now()).toISOString(),
    },
  };
}

/** Customer Service messages as Missive files them (system events left out). */
export function fromKf(messages: KfMessage[], names: Map<string, string>): ChatMessage[] {
  return messages
    .filter((m) => (m.origin === 3 || m.origin === 5) && m.external_userid)
    .map((m) => {
      const who = names.get(m.external_userid!) ?? m.external_userid!;
      const fromBot = m.origin === 5;
      return {
        chatId: `kf:${m.open_kfid}:${m.external_userid}`,
        chatTitle: who,
        messageId: m.msgid,
        senderId: fromBot ? m.open_kfid : m.external_userid!,
        senderName: fromBot ? "Customer Service" : who,
        text: m.msgtype === "text" ? m.text?.content ?? "" : placeholder(m.msgtype),
        fromBot,
        at: new Date(m.send_time * 1000).toISOString(),
      };
    });
}

/** Sends a reply into a WeCom conversation (a member of the app, or a Customer Service chat). */
export async function wecomSend(c: WecomCredentials, chatId: string, chatTitle: string, text: string, fetchFn?: typeof fetch): Promise<ChatMessage> {
  const api = wecomApi(c, fetchFn);
  let msgId: string | undefined;
  if (chatId.startsWith("kf:")) {
    const [, openKfId, externalUserId] = chatId.split(":");
    msgId = await api.sendKfText(openKfId!, externalUserId!, text);
  } else {
    if (!c.agentId) throw new HookInputError("Add the app's AgentId to reply to members");
    msgId = await api.sendAppText(chatId.replace(/^app:/, ""), text);
  }
  return {
    chatId,
    chatTitle,
    messageId: msgId || `sent:${Date.now()}`,
    senderId: c.corpId,
    senderName: "You",
    text,
    fromBot: true,
    at: new Date().toISOString(),
  };
}

// ── Zalo Official Account ──────────────────────────────────

/** Spends the refresh token once to check it and learn which OA it's for. */
export async function zaloConnect(
  input: { appId?: string; appSecret?: string; oaSecretKey?: string; refreshToken?: string },
  fetchFn?: typeof fetch,
): Promise<{ credentials: ZaloCredentials; handle: string; name: string }> {
  const appId = input.appId?.trim();
  const appSecret = input.appSecret?.trim();
  const oaSecretKey = input.oaSecretKey?.trim();
  const refreshToken = input.refreshToken?.trim();
  if (!appId || !appSecret || !oaSecretKey || !refreshToken) {
    throw new HookInputError("App ID, App Secret, OA Secret Key and an OA refresh token are required");
  }
  const api = new ZaloApi(appId, appSecret, fetchFn);
  try {
    const tokens = await api.refresh(refreshToken);
    const oa = await api.oaInfo(tokens.accessToken!);
    return {
      credentials: { appId, appSecret, oaSecretKey, oaId: oa.oaId, ...tokens, hookKey: newHookKey() },
      handle: oa.oaId,
      name: oa.name,
    };
  } catch (e) {
    throw new HookInputError(e instanceof ZaloError ? e.message : `Couldn't reach Zalo: ${String(e)}`);
  }
}

/** Zalo events that carry a message, and what kind. */
const USER_EVENT = /^user_send_(\w+)$/;
const OA_EVENT = /^oa_send_(\w+)$/;

/** Verifies and reads one webhook call: the message in it, or null for other events. Throws if it isn't genuine. */
export function zaloEvent(c: ZaloCredentials, rawBody: string, signature: string | undefined): ChatMessage | null {
  let event: ZaloEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw new HookInputError("Not a Zalo event");
  }
  if (String(event.app_id) !== c.appId || !verifyZaloSignature(signature, c.appId, rawBody, String(event.timestamp), c.oaSecretKey)) {
    throw new HookInputError("Not a genuine Zalo event");
  }
  const user = USER_EVENT.exec(event.event_name);
  const oa = OA_EVENT.exec(event.event_name);
  if ((!user && !oa) || !event.message?.msg_id) return null;
  const kind = (user ?? oa)![1]!;
  const userId = user ? event.sender?.id : event.recipient?.id;
  if (!userId) return null;
  return {
    chatId: userId,
    chatTitle: userId,
    messageId: event.message.msg_id,
    senderId: user ? userId : c.oaId,
    senderName: user ? userId : "You",
    text: kind === "text" ? event.message.text ?? "" : event.message.text || placeholder(kind),
    fromBot: !!oa,
    at: new Date(Number(event.timestamp) || Date.now()).toISOString(),
  };
}
