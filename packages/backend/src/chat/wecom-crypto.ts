import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * WeCom's callback message encryption ("WXBizMsgCrypt"): AES-256-CBC with the
 * app's EncodingAESKey, a SHA-1 signature over token, timestamp, nonce and the
 * ciphertext, and PKCS#7 padding to 32-byte blocks. The plaintext is
 * 16 random bytes, the message length (4 bytes, big-endian), the message,
 * then the corp id it was sent to.
 * https://developer.work.weixin.qq.com/document/path/90968
 */
export class WecomCrypto {
  private readonly key: Buffer;
  private readonly iv: Buffer;

  constructor(
    private readonly token: string,
    encodingAesKey: string,
    private readonly receiveId: string,
  ) {
    this.key = Buffer.from(`${encodingAesKey}=`, "base64");
    if (this.key.length !== 32) throw new Error("EncodingAESKey must be 43 characters");
    this.iv = this.key.subarray(0, 16);
  }

  signature(timestamp: string, nonce: string, encrypted: string): string {
    return createHash("sha1")
      .update([this.token, timestamp, nonce, encrypted].sort().join(""))
      .digest("hex");
  }

  verify(signature: string, timestamp: string, nonce: string, encrypted: string): boolean {
    const expected = Buffer.from(this.signature(timestamp, nonce, encrypted));
    const given = Buffer.from(String(signature ?? ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** The message inside `encrypted`; throws if it was sealed for another corp. */
  decrypt(encrypted: string): string {
    const decipher = createDecipheriv("aes-256-cbc", this.key, this.iv);
    decipher.setAutoPadding(false);
    const padded = Buffer.concat([decipher.update(encrypted, "base64"), decipher.final()]);
    const pad = padded[padded.length - 1]!;
    if (pad < 1 || pad > 32) throw new Error("Bad WeCom padding");
    const plain = padded.subarray(0, padded.length - pad);
    const length = plain.readUInt32BE(16);
    const message = plain.subarray(20, 20 + length).toString("utf8");
    const receiver = plain.subarray(20 + length).toString("utf8");
    if (receiver !== this.receiveId) throw new Error("WeCom message is for another corp");
    return message;
  }

  encrypt(message: string): string {
    const body = Buffer.from(message, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const plain = Buffer.concat([randomBytes(16), length, body, Buffer.from(this.receiveId, "utf8")]);
    const pad = 32 - (plain.length % 32);
    const cipher = createCipheriv("aes-256-cbc", this.key, this.iv);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()]).toString("base64");
  }
}

/** The text of one tag in WeCom's flat XML (CDATA or plain). */
export function xmlField(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</${tag}>`).exec(xml);
  return m ? (m[1] ?? m[2] ?? "").trim() : undefined;
}
