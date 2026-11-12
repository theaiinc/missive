import { Injectable, Logger } from "@nestjs/common";
import type { SearchQuery, SearchResult } from "@theaiinc/missive-core";
import { StorageService, SEARCH_TIMING } from "./storage/storage.service";
import { SyncService } from "./sync.service";
import { currentUser } from "./request-context";
import { safeError } from "./log-safe";

/** How long a search text counts as already looked up in Gmail (per person). */
const GMAIL_LOOKUP_MS = 10 * 60_000;
/** At most this many Gmail matches are brought in per search. */
const GMAIL_LOOKUP_LIMIT = 10;
/**
 * A search waits at most this long for Gmail; the lookup keeps going after,
 * so what it brings in shows on the next search (or the next keystroke).
 */
const GMAIL_LOOKUP_WAIT_MS = 2_500;

@Injectable()
export class SearchService {
  private readonly log = new Logger("Search");
  private readonly lookedUp = new Map<string, number>();

  constructor(
    private readonly storage: StorageService,
    private readonly sync: SyncService,
  ) {}

  /**
   * Searches Missive's copy of your mail. The Gmail sync only fetches the
   * newest inbox mail, so a typed search first asks Gmail too and brings in
   * matches Missive doesn't have yet (older or archived mail).
   */
  async search(query: SearchQuery): Promise<SearchResult> {
    const text = query.query?.trim();
    const user = currentUser();
    let gmailMs = 0;
    if (text && text.length >= 3 && !query.offset && user && query.folder !== "spam") {
      const key = `${user.id}\n${text.toLowerCase()}`;
      const last = this.lookedUp.get(key);
      if (!last || Date.now() - last > GMAIL_LOOKUP_MS) {
        this.lookedUp.set(key, Date.now());
        if (this.lookedUp.size > 1000) this.lookedUp.clear();
        const lookup = this.sync
          .importGmailMatches(text, GMAIL_LOOKUP_LIMIT)
          .catch((e) => this.log.warn(`Gmail lookup failed: ${safeError(e)}`));
        const t = Date.now();
        await Promise.race([lookup, new Promise((r) => setTimeout(r, GMAIL_LOOKUP_WAIT_MS))]);
        gmailMs = Date.now() - t;
      }
    }
    const result = await this.storage.search(query);
    const timing = (result as any)[SEARCH_TIMING] as Record<string, number> | undefined;
    if (timing) timing.gmail = gmailMs;
    return result;
  }
}
