import { describe, expect, it, vi } from "vitest";
import { SearchService } from "../search.service";
import { runAsUser } from "../request-context";

const user = { id: "f70c55df-0000-0000-0000-000000000000" } as never;
const empty = { missives: [], threads: [], total: 0 };

describe("search and the Gmail lookup", () => {
  it("answers at once while Gmail is asked, and a search again waits for what it brings in", async () => {
    let finish!: (n: number) => void;
    const lookup = new Promise<number>((r) => (finish = r));
    const sync = { importGmailMatches: vi.fn(() => lookup) };
    const storage = { search: vi.fn(async () => empty) };
    const search = new SearchService(storage as never, sync as never);

    await runAsUser(user, async () => {
      const started = Date.now();
      const first = await search.search({ query: "contract" });
      expect(Date.now() - started).toBeLessThan(200);
      expect(first.lookingUp).toBe(true);

      const again = search.search({ query: "contract" });
      finish(3);
      const second = await again;
      expect(second.lookingUp).toBeUndefined();
      expect(sync.importGmailMatches).toHaveBeenCalledTimes(1);

      // Looked up already: no new lookup, nothing to wait for.
      expect((await search.search({ query: "contract" })).lookingUp).toBeUndefined();
      expect(sync.importGmailMatches).toHaveBeenCalledTimes(1);
    });
  });
});
