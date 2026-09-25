import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
} from "@nestjs/common";
import { MissiveService } from "./missive.service";
import { SearchService } from "./search.service";
import { OrganizerService } from "./organizer.service";
import { StorageService } from "./storage/storage.service";
import type { SearchQuery } from "@theaiinc/missive-core";

@Controller("api/v1")
export class MissiveController {
  constructor(
    private readonly missive: MissiveService,
    private readonly searchService: SearchService,
    private readonly organizer: OrganizerService,
    private readonly storage: StorageService
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
    const missives = await this.missive.getRecentMissives(since, limit ? parseInt(limit, 10) : undefined);
    return { missives };
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
    @Query("organization") organization?: string,
    @Query("project") project?: string,
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
      organization,
      project,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    };
    return this.searchService.search(searchQuery);
  }

  @Get("organizer-status")
  async organizerStatus() {
    return { running: this.organizer.isRunning };
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

  @Post("missive/:id/move")
  async moveMissive(@Param("id") id: string, @Body("folder") folder: string) {
    if (!folder) return { success: false, error: "folder is required" };
    const result = await this.missive.moveMissive(id, folder);
    return { success: true, ...result };
  }

  @Post("missive/:id/spam")
  async markSpam(@Param("id") id: string, @Body("spam") spam?: boolean) {
    return this.missive.markSpam(id, spam !== false);
  }

  @Post("thread/:id/move")
  async moveThread(@Param("id") id: string, @Body("folder") folder: string) {
    if (!folder) return { success: false, error: "folder is required" };
    const result = await this.missive.moveThread(id, folder);
    return { success: true, ...result };
  }

  @Post("missive/:id/archive")
  async archiveMissive(@Param("id") id: string) {
    const result = await this.missive.moveMissive(id, "archived");
    return { success: true, ...result };
  }

  @Post("thread/:id/archive")
  async archiveThread(@Param("id") id: string) {
    const result = await this.missive.moveThread(id, "archived");
    return { success: true, ...result };
  }

  @Get("organizations")
  async listOrganizations() {
    return this.storage.listOrganizations();
  }

  @Post("missive/:id/organizations")
  async setMissiveOrganizations(
    @Param("id") id: string,
    @Body("organizations") organizations: string[]
  ) {
    if (!Array.isArray(organizations)) {
      return { error: "organizations array is required" };
    }
    await this.storage.setMissiveOrganizations(id, organizations);
    return { success: true, organizations };
  }

  @Post("thread/:id/organizations")
  async setThreadOrganizations(
    @Param("id") id: string,
    @Body("organizations") organizations: string[]
  ) {
    if (!Array.isArray(organizations)) {
      return { error: "organizations array is required" };
    }
    await this.storage.setThreadOrganizations(id, organizations);
    return { success: true, organizations };
  }

  @Get("projects")
  async listProjects() {
    return this.storage.listProjects();
  }

  @Post("missive/:id/projects")
  async setMissiveProjects(
    @Param("id") id: string,
    @Body("projects") projects: string[]
  ) {
    if (!Array.isArray(projects)) {
      return { error: "projects array is required" };
    }
    await this.storage.setMissiveProjects(id, projects);
    return { success: true, projects };
  }

  @Post("thread/:id/projects")
  async setThreadProjects(
    @Param("id") id: string,
    @Body("projects") projects: string[]
  ) {
    if (!Array.isArray(projects)) {
      return { error: "projects array is required" };
    }
    await this.storage.setThreadProjects(id, projects);
    return { success: true, projects };
  }
}