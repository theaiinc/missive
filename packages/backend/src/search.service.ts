import { Injectable } from "@nestjs/common";
import type { SearchQuery, SearchResult } from "@theaiinc/missive-core";
import { StorageService } from "./storage/storage.service";

@Injectable()
export class SearchService {
  constructor(private readonly storage: StorageService) {}

  async search(query: SearchQuery): Promise<SearchResult> {
    return this.storage.search(query);
  }
}