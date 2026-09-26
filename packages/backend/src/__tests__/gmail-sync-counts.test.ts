import { beforeEach, describe, expect, it, vi } from "vitest";
// vi.mock below is hoisted above this import, so SyncService sees the fake googleapis.
import { SyncService } from "../sync.service";

// One plain-text message (no text/html part) and one HTML message in the inbox.
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const messages: Record<string, any> = {
  plain: {
    threadId: "t-plain",
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Subject", value: "Plain" }, { name: "From", value: "A <a@example.com>" }, { name: "Date", value: "Mon, 1 Sep 2026 10:00:00 +0000" }],
      body: { data: b64("just text") },
    },
  },
  html: {
    threadId: "t-html",
    payload: {
      mimeType: "multipart/alternative",
      headers: [{ name: "Subject", value: "Rich" }, { name: "From", value: "B <b@example.com>" }, { name: "Date", value: "Mon, 1 Sep 2026 11:00:00 +0000" }],
      parts: [
        { mimeType: "text/plain", body: { data: b64("rich text") } },
        { mimeType: "text/html", body: { data: b64("<p>rich</p>") } },
      ],
    },
  },
};

vi.mock("googleapis", () => ({
  google: {
    gmail: () => ({
      users: {
        messages: {
          list: async () => ({ data: { messages: Object.keys(messages).map((id) => ({ id })) } }),
          get: async ({ id }: { id: string }) => ({ data: messages[id] }),
          attachments: { get: async () => ({ data: {} }) },
        },
      },
    }),
  },
}));


function setup() {
  const missives = new Map<string, any>();
  const threads = new Map<string, any>();
  const storage = {
    getMissive: async (id: string) => missives.get(id),
    getMissiveSyncState: async (id: string) => {
      const m = missives.get(id);
      return m ? { status: m.status, needsBodyRepair: !m.body || m.body === "(no content)" } : null;
    },
    missiveExists: async (id: string) => missives.has(id),
    saveMissive: async (m: any) => void missives.set(m.id, structuredClone(m)),
    getThread: async (id: string) => (threads.has(id) ? structuredClone(threads.get(id)) : undefined),
    saveThread: async (t: any) => void threads.set(t.id, structuredClone(t)),
  };
  const store = {
    list: async () => [{ id: "gmail:me@example.com", email: "me@example.com", tokens: {} }],
    getOAuthClientForConnector: () => ({}),
    updateLastSyncAt: async () => {},
  };
  const rules = { evaluate: vi.fn(async () => []), applyActions: vi.fn() };
  const events = { emit: vi.fn() };
  const sync = new SyncService(store as any, storage as any, rules as any, events as any);
  return { sync, missives, threads, rules, events };
}

describe("Gmail sync counts only new messages", () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => { env = setup(); });

  it("reports both messages as new on the first sync", async () => {
    const r = await env.sync.syncGmail();
    expect(r["me@example.com"]).toEqual({ synced: 2 });
  });

  it("reports nothing new when the same messages are synced again", async () => {
    await env.sync.syncGmail();
    env.rules.evaluate.mockClear();
    env.events.emit.mockClear();
    const r = await env.sync.syncGmail();
    expect(r["me@example.com"]).toEqual({ synced: 0 });
    expect(env.rules.evaluate).not.toHaveBeenCalled();
    expect(env.events.emit).not.toHaveBeenCalled();
  });

  it("keeps a message read after it is synced again (plain-text messages included)", async () => {
    await env.sync.syncGmail();
    for (const m of env.missives.values()) m.status = "read";
    await env.sync.syncGmail();
    expect([...env.missives.values()].map((m) => m.status)).toEqual(["read", "read"]);
  });

  it("does not add a message to its thread twice", async () => {
    await env.sync.syncGmail();
    await env.sync.syncGmail();
    await env.sync.syncGmail();
    expect(env.threads.get("t-plain").missiveIds).toEqual(["plain"]);
    expect(env.threads.get("t-plain").messageCount).toBe(1);
  });

  it("repairs a message stored with an empty body without counting it as new", async () => {
    await env.sync.syncGmail();
    env.missives.get("plain").body = "(no content)";
    env.missives.get("plain").status = "read";
    const r = await env.sync.syncGmail();
    expect(r["me@example.com"]).toEqual({ synced: 0 });
    expect(env.missives.get("plain").body).toBe("just text");
    expect(env.missives.get("plain").status).toBe("read");
  });
});
