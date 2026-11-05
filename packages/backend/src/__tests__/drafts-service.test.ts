import { describe, expect, it, vi } from "vitest";
import { DraftsService } from "../drafts.service";

const requireUser = vi.hoisted(() => vi.fn(() => ({ id: "user-1" })));
vi.mock("../request-context", () => ({ requireUser }));

const row = { id: "d1", mailbox: "me@example.com", payload: { subject: "Hi" }, updated_at: "2026-11-05T01:00:00Z", created_at: "2026-11-05T00:00:00Z" };

describe("DraftsService ownership", () => {
  it("lists only the signed-in user's drafts, newest first", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [row] }) };
    const drafts = await new DraftsService(db as never).list();
    const [sql, params] = db.query.mock.calls[0]!;
    expect(sql).toMatch(/WHERE owner_id = \$1 ORDER BY updated_at DESC/);
    expect(params).toEqual(["user-1"]);
    expect(drafts).toEqual([{ id: "d1", mailbox: "me@example.com", payload: { subject: "Hi" }, updatedAt: "2026-11-05T01:00:00.000Z", createdAt: "2026-11-05T00:00:00.000Z" }]);
  });

  it("deletes only the signed-in user's draft and says whether it did", async () => {
    const db = { query: vi.fn().mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 }) };
    const service = new DraftsService(db as never);
    await expect(service.remove("d1")).resolves.toBe(true);
    await expect(service.remove("d2")).resolves.toBe(false);
    expect(db.query.mock.calls[0]).toEqual(["DELETE FROM drafts WHERE id = $1 AND owner_id = $2", ["d1", "user-1"]]);
  });

  it("returns null when the id is another user's draft", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const service = new DraftsService(db as never);
    await expect(service.upsert({ id: "d1", mailbox: "me@example.com", payload: {} })).resolves.toBeNull();
    expect(db.query.mock.calls[0]![0]).toMatch(/WHERE drafts\.owner_id = \$2/);
  });
});
