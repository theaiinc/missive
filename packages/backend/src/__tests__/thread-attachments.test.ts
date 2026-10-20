import { describe, expect, it, vi } from "vitest";

// Decrypting needs the row's owner to pick their key; here it just checks it was given one.
vi.mock("../data-cipher", () => ({
  dataCipher: () => ({
    decrypt: async (scope: unknown, _aad: string, _value: string) => {
      if (!scope) throw new Error("no key");
      return "Proposal.docx";
    },
  }),
}));

import { StorageService } from "../storage/storage.service";

describe("a conversation's attachments", () => {
  it("lists them with their names decrypted (the listing selects the owner)", async () => {
    // Like Postgres: only the columns the query names come back.
    const row = { id: "a_1", owner_id: "f70c55df-0000-0000-0000-000000000000", missive_id: "m_1", filename: "mv1.ciphertext", mime_type: "application/pdf", size: 12 };
    const query = vi.fn(async (sql: string) => {
      const cols = /SELECT (.+) FROM attachments/s.exec(sql)![1]!.split(",").map((c) => c.trim());
      return { rows: [Object.fromEntries(cols.map((c) => [c, (row as Record<string, unknown>)[c]]))] };
    });
    const storage = new StorageService({ query } as never);
    expect(await storage.listAttachments(["m_1"])).toEqual([
      { id: "a_1", missiveId: "m_1", filename: "Proposal.docx", mimeType: "application/pdf", size: 12 },
    ]);
  });
});
