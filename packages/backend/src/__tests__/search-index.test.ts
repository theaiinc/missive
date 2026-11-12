import { describe, expect, it, vi } from "vitest";

// Stored values are "mv1.<plain>"; decrypting strips the prefix and is counted.
const decrypts = vi.hoisted(() => ({ n: 0 }));
vi.mock("../data-cipher", () => ({
  dataCipher: () => ({
    decrypt: async (_scope: unknown, _aad: string, value: string) => {
      decrypts.n++;
      return value.slice(4);
    },
  }),
}));
vi.mock("@theaiinc/missive-core", async (orig) => ({
  ...(await orig<object>()),
  isEncryptedText: (v: unknown) => typeof v === "string" && v.startsWith("mv1."),
}));

import { StorageService } from "../storage/storage.service";
import { searchTerms } from "../chat.service";

const owner = "f70c55df-0000-0000-0000-000000000000";
const enc = (s: string) => `mv1.${s}`;
const mail = [
  { id: "m1", subject: "Invoice #42", body: "Please pay by Friday", sender_name: "Acme Billing", sender_address: "billing@acme.com", received_at: "2026-11-10T00:00:00Z" },
  { id: "m2", subject: "Lunch?", body: "Are you free for lunch with Dana", sender_name: "Dana Lee", sender_address: "dana@example.com", received_at: "2026-11-09T00:00:00Z" },
  { id: "m3", subject: "Weekly digest", body: "Acme shipped the invoice redesign", sender_name: "News", sender_address: "news@digest.io", received_at: "2026-11-08T00:00:00Z" },
].map((m) => ({
  ...m,
  owner_id: owner,
  thread_id: m.id,
  received_at: new Date(m.received_at),
  created_at: new Date(m.received_at),
  updated_at: new Date("2026-11-11T00:00:00Z"),
  subject: enc(m.subject),
  body: enc(m.body),
  sender_name: enc(m.sender_name),
  sender_address: enc(m.sender_address),
  recipients: JSON.stringify(enc(JSON.stringify([{ address: "me@theaiinc.com" }]))),
  folder: "inbox",
  status: "read",
}));

function fakePg() {
  const query = vi.fn(async (sql: string, params?: any[]) => {
    if (/FROM threads/.test(sql)) return { rows: [] };
    const ids: string[] | undefined = /id = ANY/.test(sql) ? params![0] : undefined;
    const rows = mail.filter((m) => !ids || ids.includes(m.id));
    return { rows: rows.map((r) => ({ ...r })) };
  });
  return query;
}

describe("message search", () => {
  it("finds mail by sender name, sender address and body text", async () => {
    const storage = new StorageService({ query: fakePg() } as never);
    const ids = async (q: string) => (await storage.search({ query: q })).missives.map((m) => m.id);
    expect(await ids("dana lee")).toEqual(["m2"]);
    expect(await ids("billing@acme")).toEqual(["m1"]);
    expect(await ids("pay by friday")).toEqual(["m1"]);
    expect(await ids("acme")).toEqual(["m1", "m3"]);
    expect((await storage.search({ query: "nothing-like-this" })).total).toBe(0);
  });

  it("decrypts each message once, not on every search", async () => {
    const storage = new StorageService({ query: fakePg() } as never);
    await storage.search({ query: "invoice" });
    const after = decrypts.n;
    await storage.search({ query: "lunch" });
    // Only the one result's list row is opened again; the index is reused.
    expect(decrypts.n - after).toBeLessThan(8);
  });

  it("ranks AI search matches by how many terms they hit", async () => {
    const storage = new StorageService({ query: fakePg() } as never);
    const found = await storage.searchByTerms(searchTerms("Find the invoice email from Acme"));
    expect(found.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("drops filler words from an AI search question", () => {
    expect(searchTerms("What did Dana say about lunch last week?")).toEqual(["dana", "say", "lunch"]);
  });
});
