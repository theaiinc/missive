import { describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { EMPTY_DRAFT_SQL, isEmptyDraftPayload } from "../draft-content";
import { cleanupEmptyDrafts, COUNT_EMPTY_DRAFTS, DELETE_EMPTY_DRAFTS } from "../scripts/cleanup-empty-drafts";

/** Payloads and whether each is empty; the SQL must agree with isEmptyDraftPayload on every one. */
const CASES: Array<[Record<string, unknown>, boolean]> = [
  [{}, true],
  [{ to: "", cc: "", bcc: "", subject: "", html: "", text: "", attachments: [] }, true],
  [{ to: "  ", subject: " ", html: "<p></p>", text: "-- \nSteve" }, true],
  [{ html: "<p>&nbsp;</p><p> </p>" }, true],
  [{ to: "a@example.com" }, false],
  [{ cc: "a@example.com" }, false],
  [{ bcc: "a@example.com" }, false],
  [{ subject: "Hello" }, false],
  [{ html: "<p>Hi</p>" }, false],
  [{ attachments: [{ filename: "a.pdf", mimeType: "application/pdf", size: 3 }] }, false],
];

describe("isEmptyDraftPayload", () => {
  it.each(CASES)("%j is empty: %s", (payload, empty) => {
    expect(isEmptyDraftPayload(payload)).toBe(empty);
  });
});

describe("cleanupEmptyDrafts", () => {
  it("only counts with --dry-run", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ count: 7 }], rowCount: 1 }) };
    await expect(cleanupEmptyDrafts(db, { dryRun: true })).resolves.toBe(7);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0]![0]).toBe(COUNT_EMPTY_DRAFTS);
    expect(db.query.mock.calls[0]![0]).not.toMatch(/DELETE/);
  });

  it("goes by is_empty, and judges only a plain (object) payload by its content", () => {
    expect(EMPTY_DRAFT_SQL).toMatch(/is_empty IS TRUE/);
    expect(EMPTY_DRAFT_SQL).toMatch(/is_empty IS NULL AND jsonb_typeof\(payload\) = 'object' AND/);
  });

  it("deletes empty drafts older than an hour", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 3 }) };
    await expect(cleanupEmptyDrafts(db, { dryRun: false })).resolves.toBe(3);
    expect(db.query.mock.calls[0]).toEqual([DELETE_EMPTY_DRAFTS, ["1 hour"]]);
    expect(DELETE_EMPTY_DRAFTS).toMatch(/updated_at < NOW\(\) - \$1::interval/);
  });
});

// Against a real Postgres when TEST_DATABASE_URL is set (a throwaway database: it creates a temp table).
describe.skipIf(!process.env.TEST_DATABASE_URL)("cleanup SQL on Postgres", () => {
  it("matches isEmptyDraftPayload on plain drafts, goes by is_empty on encrypted ones, and spares recent drafts", async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("CREATE TEMP TABLE drafts (id int PRIMARY KEY, payload jsonb NOT NULL, is_empty boolean, updated_at timestamptz NOT NULL)");
      let id = 0;
      // Plain, from before encryption (is_empty NULL).
      for (const [payload] of CASES) {
        await client.query("INSERT INTO drafts VALUES ($1, $2, NULL, NOW() - interval '2 hours')", [++id, JSON.stringify(payload)]);
      }
      const kept = CASES.map(([, empty], i) => (empty ? null : i + 1)).filter((n) => n !== null);
      // Encrypted (a JSON string): only is_empty says.
      const sealed = JSON.stringify("mv1.ciphertext");
      await client.query("INSERT INTO drafts VALUES ($1, $2, true, NOW() - interval '2 hours')", [++id, sealed]);
      await client.query("INSERT INTO drafts VALUES ($1, $2, false, NOW() - interval '2 hours')", [++id, sealed]);
      kept.push(id);
      // Encrypted with is_empty unknown: never taken for empty.
      await client.query("INSERT INTO drafts VALUES ($1, $2, NULL, NOW() - interval '2 hours')", [++id, sealed]);
      kept.push(id);
      // Recent: spared even though empty.
      await client.query("INSERT INTO drafts VALUES ($1, '{}', NULL, NOW() - interval '10 minutes')", [++id]);
      kept.push(id);
      await client.query("INSERT INTO drafts VALUES ($1, $2, true, NOW() - interval '10 minutes')", [++id, sealed]);
      kept.push(id);
      const db = { query: (text: string, params?: unknown[]) => client.query(text, params) };
      const expected = CASES.filter(([, empty]) => empty).length + 1;
      await expect(cleanupEmptyDrafts(db, { dryRun: true })).resolves.toBe(expected);
      await expect(cleanupEmptyDrafts(db, { dryRun: false })).resolves.toBe(expected);
      const { rows } = await client.query("SELECT id FROM drafts ORDER BY id");
      expect(rows.map((r) => r.id)).toEqual(kept);
    } finally {
      client.release();
      await pool.end();
    }
  });
});
