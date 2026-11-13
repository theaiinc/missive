import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { WecomCrypto, xmlField } from "../wecom-crypto";
import { verifyZaloSignature } from "../zalo-api";

// The sample from WeCom's callback docs (developer.work.weixin.qq.com/document/path/90968).
const doc = {
  token: "QDG6eK",
  corpId: "wx5823bf96d3bd56c7",
  aesKey: "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C",
  signature: "5c45ff5e21c57e6ad56bac8758b79b1d9ac89fd3",
  timestamp: "1409659589",
  nonce: "263014780",
  echostr: "P9nAzCzyDtyTWESHep1vC5X9xho/qYX3Zpb4yKa9SKld1DsH3Iyt3tP3zNdtp+4RPcs8TgAE7OaBO+FZXvnaqQ==",
};

describe("WeCom callback crypto", () => {
  const crypto = new WecomCrypto(doc.token, doc.aesKey, doc.corpId);

  it("verifies and decrypts WeCom's own sample URL check", () => {
    expect(crypto.verify(doc.signature, doc.timestamp, doc.nonce, doc.echostr)).toBe(true);
    expect(crypto.decrypt(doc.echostr)).toBe("1616140317555161061");
  });

  it("round-trips a message, including non-ASCII text", () => {
    const xml = "<xml><Content><![CDATA[你好, xin chào]]></Content></xml>";
    expect(crypto.decrypt(crypto.encrypt(xml))).toBe(xml);
  });

  it("refuses a bad signature and a message for another corp", () => {
    expect(crypto.verify("0".repeat(40), doc.timestamp, doc.nonce, doc.echostr)).toBe(false);
    const other = new WecomCrypto(doc.token, doc.aesKey, "ww_other");
    expect(() => other.decrypt(doc.echostr)).toThrow(/another corp/);
  });

  it("reads CDATA and plain XML fields", () => {
    const xml = "<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>1348831860</CreateTime></xml>";
    expect(xmlField(xml, "FromUserName")).toBe("zhangsan");
    expect(xmlField(xml, "CreateTime")).toBe("1348831860");
    expect(xmlField(xml, "Missing")).toBeUndefined();
  });
});

describe("Zalo webhook signature", () => {
  it("accepts mac=sha256(appId + body + timestamp + secret) and nothing else", () => {
    const body = '{"event_name":"user_send_text"}';
    const mac = "mac=" + createHash("sha256").update(`123${body}1700000000000secret`).digest("hex");
    expect(verifyZaloSignature(mac, "123", body, "1700000000000", "secret")).toBe(true);
    expect(verifyZaloSignature(mac, "123", body + " ", "1700000000000", "secret")).toBe(false);
    expect(verifyZaloSignature(undefined, "123", body, "1700000000000", "secret")).toBe(false);
  });
});
