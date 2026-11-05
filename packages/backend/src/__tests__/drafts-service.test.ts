import { beforeAll, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { DraftsService } from "../drafts.service";
import { DraftUnreadableError, sealDraft } from "../draft-crypto";

const OWNER = "11111111-1111-4111-8111-111111111111";
const requireUser = vi.hoisted(() => vi.fn(() => ({ id: "11111111-1111-4111-8111-111111111111" })));
vi.mock("../request-context", () => ({ requireUser }));

const D1 = "2f1d3c4b-5a69-4788-9abc-def012345678";
const D2 = "3f1d3c4b-5a69-4788-9abc-def012345678";
const times = { updated_at: "2026-11-05T01:00:00Z", created_at: "2026-11-05T00:00:00Z" };

beforeAll(() => {
  process.env.MISSIVE_DATA_KEY ??= "test-key-0123456789abcdef0123456789abcdef";
});

async function encryptedRow(id: string, payload: Record<string, unknown>) {
  const sealed = await sealDraft(OWNER, id, { mailbox: "me@example.com", payload });
  return { id, owner_id: OWNER, mailbox: sealed.mailbox, payload: JSON.parse(sealed.payload), ...times };
}

describe("DraftsService ownership", () => {
  it("lists only the signed-in user's drafts, newest first, decrypted", async () => {
    const plain = { id: D2, owner_id: OWNER, mailbox: "me@example.com", payload: { subject: "Old" }, ...times };
    const db = { query: vi.fn().mockResolvedValue({ rows: [await encryptedRow(D1, { subject: "Hi", to: "a@b.c" }), plain] }) };
    const drafts = await new DraftsService(db as never).list();
    const [sql, params] = db.query.mock.calls[0]!;
    expect(sql).toMatch(/WHERE owner_id = \$1 ORDER BY updated_at DESC/);
    expect(params).toEqual([OWNER]);
    expect(drafts).toEqual([
      { id: D1, mailbox: "me@example.com", payload: { subject: "Hi", to: "a@b.c" }, updatedAt: "2026-11-05T01:00:00.000Z", createdAt: "2026-11-05T00:00:00.000Z" },
      { id: D2, mailbox: "me@example.com", payload: { subject: "Old" }, updatedAt: "2026-11-05T01:00:00.000Z", createdAt: "2026-11-05T00:00:00.000Z" },
    ]);
    expect(JSON.stringify(drafts)).not.toContain("mv1.");
  });

  it("leaves a draft that doesn't decrypt out of the list, logging only its id", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const good = await encryptedRow(D1, { subject: "Hi" });
    // D2's row holds D1's ciphertext (copied): it must not open.
    const moved = { ...(await encryptedRow(D1, { subject: "Secret subject" })), id: D2 };
    const db = { query: vi.fn().mockResolvedValue({ rows: [good, moved] }) };
    const drafts = await new DraftsService(db as never).list();
    expect(drafts.map((d) => d.id)).toEqual([D1]);
    expect(warn).toHaveBeenCalledWith(`Draft ${D2} could not be decrypted`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Secret");
    warn.mockRestore();
  });

  it("refuses to return a draft that doesn't decrypt", async () => {
    const row = await encryptedRow(D1, { subject: "Secret subject" });
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ ...row, owner_id: "22222222-2222-4222-8222-222222222222" }] }) };
    await expect(new DraftsService(db as never).get(D1)).rejects.toBeInstanceOf(DraftUnreadableError);
  });

  it("stores the draft encrypted, with is_empty, and returns it plain", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: D1, ...times }] }) };
    const payload = { to: "secret-recipient@example.com", subject: "Secret subject", html: "<p>Secret body</p>" };
    const saved = await new DraftsService(db as never).upsert({ id: D1, mailbox: "me@example.com", payload });
    const [sql, params] = db.query.mock.calls[0]!;
    expect(sql).toMatch(/is_empty = EXCLUDED\.is_empty/);
    expect(JSON.stringify(params)).not.toMatch(/Secret|secret|me@example\.com/);
    expect(params[3]).toMatch(/^"mv1\./);
    expect(params[4]).toBe(false);
    expect(saved).toEqual({ id: D1, mailbox: "me@example.com", payload, updatedAt: "2026-11-05T01:00:00.000Z", createdAt: "2026-11-05T00:00:00.000Z" });
  });

  it("deletes only the signed-in user's draft and says whether it did", async () => {
    const db = { query: vi.fn().mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 }) };
    const service = new DraftsService(db as never);
    await expect(service.remove("d1")).resolves.toBe(true);
    await expect(service.remove("d2")).resolves.toBe(false);
    expect(db.query.mock.calls[0]).toEqual(["DELETE FROM drafts WHERE id = $1 AND owner_id = $2", ["d1", OWNER]]);
  });

  it("returns null when the id is another user's draft", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const service = new DraftsService(db as never);
    await expect(service.upsert({ id: D1, mailbox: "me@example.com", payload: {} })).resolves.toBeNull();
    expect(db.query.mock.calls[0]![0]).toMatch(/WHERE drafts\.owner_id = \$2/);
  });
});
