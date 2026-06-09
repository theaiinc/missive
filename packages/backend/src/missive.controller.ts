import {
  Controller,
  Get,
  Post,
  Param,
  Query,
} from "@nestjs/common";
import { MissiveService } from "./missive.service";
import { SearchService } from "./search.service";
import type { SearchQuery } from "@theaiinc/missive-core";

@Controller("api/v1")
export class MissiveController {
  constructor(
    private readonly missive: MissiveService,
    private readonly searchService: SearchService
  ) {}

  @Get("missive/:id")
  async getMissive(@Param("id") id: string) {
    return this.missive.getMissive(id);
  }

  @Get("thread/:id")
  async getThread(@Param("id") id: string) {
    return this.missive.getThread(id);
  }

  @Get("thread/:id/missives")
  async getThreadMissives(@Param("id") id: string) {
    return this.missive.getThreadMissives(id);
  }

  @Get("recent-missives")
  async getRecentMissives(
    @Query("since") since: string,
    @Query("limit") limit?: string
  ) {
    if (!since) {
      return { missives: [] };
    }
    return this.missive.getRecentMissives(since, limit ? parseInt(limit, 10) : undefined);
  }

  @Get("search")
  async handleSearch(
    @Query("query") query?: string,
    @Query("channel") channel?: string,
    @Query("provider") provider?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("after") after?: string,
    @Query("before") before?: string,
    @Query("folder") folder?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    const searchQuery: SearchQuery = {
      query: query ?? "",
      channel,
      provider,
      from,
      to,
      after,
      before,
      folder,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    };
    return this.searchService.search(searchQuery);
  }

  @Post("thread/:id/summarize")
  async summarize(@Param("id") id: string) {
    return this.missive.summarize(id);
  }

  @Post("missive/:id/classify")
  async classify(@Param("id") id: string) {
    return this.missive.classify(id);
  }

  @Post("missive/:id/extract")
  async extractEntities(@Param("id") id: string) {
    return this.missive.extractEntities(id);
  }
}