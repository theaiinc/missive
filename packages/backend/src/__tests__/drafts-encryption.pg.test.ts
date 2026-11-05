import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { Pool } from "pg";
import { PostgresService } from "../storage/postgres.service";
import { runAsUser } from "../request-context";
import { DraftsService } from "../drafts.service";
import { encryptDrafts } from "../draft-backfill";
import { EncryptionBackfillService } from "../encryption-backfill.service";
import { cleanupEmptyDrafts } from "../scripts/cleanup-empty-drafts";

/**
 * Drafts encryption end to end on a real Postgres, with the real migrations
 * and row-level security, when TEST_DATABASE_URL is set. It must be a
 * throwaway database: it runs every migration and writes users and drafts.
 * Raw reads and seeding bypass row-level security, so they go through
 * TEST_ADMIN_DATABASE_URL (a superuser or BYPASSRLS role on the same
 * database) when the TEST_DATABASE_URL role doesn't bypass it.
 */
const url = process.env.TEST_DATABASE_URL;
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? url;

const A = { id: "a0000000-0000-4000-8000-000000000001", email: "" };
const B = { id: "b0000000-0000-4000-8000-000000000002", email: "" };
const uuid = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SECRET = "Secret quarterly numbers";

describe.skipIf(!url)("drafts encryption on Postgres", () => {
  let pg: PostgresService;
  let admin: Pool;
  const logs: string[] = [];
  const capture = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.MISSIVE_DATA_KEY ??= "test-key-0123456789abcdef0123456789abcdef";
    for (const m of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, m).mockImplementation(capture);
    for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(capture);
    pg = new PostgresService();
    await pg.onModuleInit();
    admin = new Pool({ connectionString: adminUrl, max: 2 });
    await admin.query("TRUNCATE drafts");
    await pg.systemQuery("DELETE FROM users WHERE id = ANY($1::uuid[])", [[A.id, B.id]]);
    for (const u of [A, B]) await pg.systemQuery("INSERT INTO users (id, email) VALUES ($1, $2)", [u.id, `${u.id}@example.test`]);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await pg?.pool.end();
    await admin?.end();
  });

  const raw = async (id: string) => {
    const { rows } = await admin.query("SELECT mailbox, payload, is_empty FROM drafts WHERE id = $1", [id]);
    expect(rows).toHaveLength(1);
    return rows[0];
  };
  const drafts = () => new DraftsService(pg);

  it("saves encrypted and reads back for the owner only", async () => {
    const payload = { to: "client@example.com", subject: SECRET, html: `<p>${SECRET}</p>`, text: SECRET, attachments: [] };
    await runAsUser(A, () => drafts().upsert({ id: uuid(1), mailbox: "a@example.com", payload }));
    const row = await raw(uuid(1));
    expect(JSON.stringify(row)).not.toMatch(/Secret|client@example\.com|a@example\.com/);
    expect(row.payload).toMatch(/^mv1\./);
    expect(row.is_empty).toBe(false);
    const listed = await runAsUser(A, () => drafts().list());
    expect(listed).toEqual([expect.objectContaining({ id: uuid(1), mailbox: "a@example.com", payload })]);
    expect(await runAsUser(B, () => drafts().get(uuid(1)))).toBeNull();
  });

  it("fails closed for a row copied to another draft", async () => {
    await admin.query(
      "INSERT INTO drafts (id, owner_id, mailbox, payload, is_empty) SELECT $2, owner_id, mailbox, payload, is_empty FROM drafts WHERE id = $1",
      [uuid(1), uuid(2)],
    );
    await expect(runAsUser(A, () => drafts().get(uuid(2)))).rejects.toThrow(`Draft ${uuid(2)} could not be decrypted`);
    expect((await runAsUser(A, () => drafts().list())).map((d) => d.id)).toEqual([uuid(1)]);
    await admin.query("DELETE FROM drafts WHERE id = $1", [uuid(2)]);
  });

  it("encrypts plain rows in place, leaves encrypted ones alone, and is idempotent", async () => {
    const plain = (n: number, owner: string, payload: object, age = "2 hours") =>
      admin.query(
        `INSERT INTO drafts (id, owner_id, mailbox, payload, updated_at) VALUES ($1, $2, 'old@example.com', $3::jsonb, NOW() - $4::interval)`,
        [uuid(n), owner, JSON.stringify(payload), age],
      );
    await plain(10, A.id, { subject: SECRET, to: "x@example.com" });
    await plain(11, A.id, { html: "<p></p>" });
    await plain(12, B.id, { subject: "B's draft" });
    await plain(13, B.id, {});
    const before = await raw(uuid(1));
    const updatedBefore = (await admin.query("SELECT updated_at FROM drafts WHERE id = $1", [uuid(10)])).rows[0].updated_at;

    // Cleanup during the transition finds the plain empty drafts.
    await expect(cleanupEmptyDrafts(admin, { dryRun: true })).resolves.toBe(2);

    const dry = await encryptDrafts(pg, { dryRun: true });
    expect(dry).toMatchObject({ total: 5, encrypted: 1, pending: 4, done: 0 });
    expect((await raw(uuid(10))).mailbox).toBe("old@example.com");

    const run = await encryptDrafts(pg, { dryRun: false, batch: 1 });
    expect(run).toMatchObject({ total: 5, encrypted: 1, pending: 4, done: 4 });
    for (const n of [10, 11, 12, 13]) {
      const row = await raw(uuid(n));
      expect(row.payload).toMatch(/^mv1\./);
      expect(row.mailbox).toMatch(/^mv1\./);
      expect(JSON.stringify(row)).not.toMatch(/Secret|old@example|B's draft/);
    }
    expect((await raw(uuid(11))).is_empty).toBe(true);
    expect((await raw(uuid(10))).is_empty).toBe(false);
    // The already-encrypted row is byte-for-byte untouched, and updated_at kept.
    expect(await raw(uuid(1))).toEqual(before);
    expect((await admin.query("SELECT updated_at FROM drafts WHERE id = $1", [uuid(10)])).rows[0].updated_at).toEqual(updatedBefore);

    const again = await encryptDrafts(pg, { dryRun: false });
    expect(again).toMatchObject({ total: 5, encrypted: 5, pending: 0, done: 0 });

    // Each owner reads their converted drafts.
    expect((await runAsUser(B, () => drafts().get(uuid(12))))?.payload).toEqual({ subject: "B's draft" });
    expect((await runAsUser(A, () => drafts().get(uuid(10))))?.mailbox).toBe("old@example.com");

    // Cleanup after conversion still finds the empty ones, by is_empty.
    await expect(cleanupEmptyDrafts(admin, { dryRun: true })).resolves.toBe(2);
    await expect(cleanupEmptyDrafts(admin, { dryRun: false })).resolves.toBe(2);
    const left = (await admin.query("SELECT id FROM drafts ORDER BY id")).rows.map((r) => r.id);
    expect(left).toEqual([uuid(1), uuid(10), uuid(12)]);
  });

  it("the startup backfill converts plain drafts too, logging only counts", async () => {
    await admin.query(
      `INSERT INTO drafts (id, owner_id, mailbox, payload) VALUES ($1, $2, 'boot@example.com', $3::jsonb), ($4, $5, 'boot@example.com', '{}'::jsonb)`,
      [uuid(20), A.id, JSON.stringify({ subject: SECRET }), uuid(21), B.id],
    );
    const encryptedBefore = await raw(uuid(1));
    const backfill = new EncryptionBackfillService(pg, {} as never);
    const from = logs.length;
    await backfill.drafts();
    expect(logs.slice(from)).toEqual(["drafts: encrypted 2 draft(s)"]);
    for (const n of [20, 21]) expect((await raw(uuid(n))).payload).toMatch(/^mv1\./);
    expect((await raw(uuid(21))).is_empty).toBe(true);
    expect(await raw(uuid(1))).toEqual(encryptedBefore);
    expect((await runAsUser(A, () => drafts().get(uuid(20))))?.payload).toEqual({ subject: SECRET });
    // Again: nothing left to do, nothing logged.
    await backfill.drafts();
    expect(logs.slice(from)).toHaveLength(1);
  });

  it("logged nothing of any draft", () => {
    expect(logs.join("\n")).not.toMatch(/Secret|client@example|old@example|boot@example|B's draft/);
  });
});
