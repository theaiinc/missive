import { describe, expect, it } from "vitest";
import { DataCipher, isEncryptedBytes, isEncryptedText, userScope } from "../crypto";

const cipher = DataCipher.fromSecret("x".repeat(64));

describe("DataCipher", () => {
  it("round-trips text and never stores the plaintext", async () => {
    const sealed = await cipher.encrypt(userScope("u1"), "missives.body", "Hi Steve, invoice attached");
    expect(isEncryptedText(sealed)).toBe(true);
    expect(sealed).not.toContain("invoice");
    expect(await cipher.decrypt(userScope("u1"), "missives.body", sealed)).toBe("Hi Steve, invoice attached");
  });

  it("uses a fresh IV, so the same text encrypts differently each time", async () => {
    const a = await cipher.encrypt(userScope("u1"), "missives.subject", "same");
    const b = await cipher.encrypt(userScope("u1"), "missives.subject", "same");
    expect(a).not.toBe(b);
  });

  it("one user's key cannot open another user's data", async () => {
    const sealed = await cipher.encrypt(userScope("u1"), "missives.body", "private");
    await expect(cipher.decrypt(userScope("u2"), "missives.body", sealed)).rejects.toThrow();
  });

  it("a value cannot be moved to another column", async () => {
    const sealed = await cipher.encrypt(userScope("u1"), "missives.subject", "subject");
    await expect(cipher.decrypt(userScope("u1"), "missives.body", sealed)).rejects.toThrow();
  });

  it("detects tampering", async () => {
    const sealed = await cipher.encrypt(userScope("u1"), "missives.body", "hello");
    const flipped = sealed.slice(0, -2) + (sealed.endsWith("A") ? "B" : "A") + sealed.slice(-1);
    await expect(cipher.decrypt(userScope("u1"), "missives.body", flipped)).rejects.toThrow();
  });

  it("a different master key cannot decrypt", async () => {
    const sealed = await cipher.encrypt(userScope("u1"), "missives.body", "hello");
    const other = DataCipher.fromSecret("y".repeat(64));
    await expect(other.decrypt(userScope("u1"), "missives.body", sealed)).rejects.toThrow();
  });

  it("round-trips binary objects (raw inbound mail)", async () => {
    const raw = new TextEncoder().encode("From: a@b.c\r\nSubject: hi\r\n\r\nbody");
    const sealed = await cipher.encryptBytes("system:inbound", "inbound/2026-09-24/x.eml", raw);
    expect(isEncryptedBytes(sealed)).toBe(true);
    expect(new TextDecoder().decode(sealed)).not.toContain("Subject: hi");
    const back = await cipher.decryptBytes("system:inbound", "inbound/2026-09-24/x.eml", sealed);
    expect(new TextDecoder().decode(back)).toBe("From: a@b.c\r\nSubject: hi\r\n\r\nbody");
    await expect(cipher.decryptBytes("system:inbound", "inbound/2026-09-24/other.eml", sealed)).rejects.toThrow();
  });

  it("blind index is stable, keyed, and label-separated", async () => {
    const a = await cipher.blindIndex("users.email", "steve@example.com");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await cipher.blindIndex("users.email", "steve@example.com")).toBe(a);
    expect(await cipher.blindIndex("mailboxes.address", "steve@example.com")).not.toBe(a);
    expect(await DataCipher.fromSecret("y".repeat(64)).blindIndex("users.email", "steve@example.com")).not.toBe(a);
  });

  it("refuses a missing or short master key", () => {
    expect(() => DataCipher.fromSecret(undefined)).toThrow();
    expect(() => DataCipher.fromSecret("short")).toThrow();
  });

  it("null-safe helpers pass null through", async () => {
    expect(await cipher.encryptOptional(userScope("u1"), "a", null)).toBeNull();
    expect(await cipher.decryptOptional(userScope("u1"), "a", undefined)).toBeNull();
  });
});
