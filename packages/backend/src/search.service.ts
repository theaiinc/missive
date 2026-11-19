import { Injectable, Logger } from "@nestjs/common";
import type { SearchQuery, SearchResult } from "@theaiinc/missive-core";
import { StorageService } from "./storage/storage.service";
import { SyncService } from "./sync.service";
import { currentUser } from "./request-context";
import { safeError } from "./log-safe";

/** How long a search text counts as already looked up in Gmail (per person). */
const GMAIL_LOOKUP_MS = 10 * 60_000;
/** At most this many Gmail matches are brought in per search. */
const GMAIL_LOOKUP_LIMIT = 10;
/**
 * A search never waits for a new Gmail lookup: it answers from Missive's copy
 * at once and says the lookup is running (`lookingUp`). The page searches
 * again shortly; that search waits at most this long for the lookup to end.
 * (Waiting 2.5 s on every new query is what made typing a search feel slow.)
 */
const GMAIL_LOOKUP_WAIT_MS = 2_500;

@Injectable()
export class SearchService {
  private readonly log = new Logger("Search");
  private readonly lookedUp = new Map<string, number>();
  /** Lookups still running, by the same key. */
  private readonly running = new Map<string, Promise<unknown>>();

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
    let lookingUp = false;
    if (text && text.length >= 3 && !query.offset && user && query.folder !== "spam") {
      const key = `${user.id}\n${text.toLowerCase()}`;
      const inFlight = this.running.get(key);
      const last = this.lookedUp.get(key);
      if (inFlight) {
        // The page searching again for this text: wait (a while) for what Gmail brings in.
        await Promise.race([inFlight, new Promise((r) => setTimeout(r, GMAIL_LOOKUP_WAIT_MS))]);
        lookingUp = this.running.has(key);
      } else if (!last || Date.now() - last > GMAIL_LOOKUP_MS) {
        this.lookedUp.set(key, Date.now());
        if (this.lookedUp.size > 1000) this.lookedUp.clear();
        const lookup = this.sync
          .importGmailMatches(text, GMAIL_LOOKUP_LIMIT)
          .catch((e) => this.log.warn(`Gmail lookup failed: ${safeError(e)}`))
          .finally(() => this.running.delete(key));
        this.running.set(key, lookup);
        lookingUp = true;
      }
    }
    const result = await this.storage.search(query);
    return lookingUp ? { ...result, lookingUp } : result;
  }
}
