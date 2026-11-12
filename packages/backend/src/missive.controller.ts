import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  HttpException,
  NotFoundException,
} from "@nestjs/common";
import { MissiveService } from "./missive.service";
import { SearchService } from "./search.service";
import { OrganizerService } from "./organizer.service";
import { StorageService } from "./storage/storage.service";
import type { SearchQuery } from "@theaiinc/missive-core";
import { LANGUAGES, translate } from "./translate";
import { draft, nameFromEmail } from "./draft";
import { WritingError } from "./writing";
import { requireUser } from "./request-context";
import { GmailSendService } from "./gmail-send.service";
import { replyRecipients } from "./addresses";

@Controller("api/v1")
export class MissiveController {
  constructor(
    private readonly missive: MissiveService,
    private readonly searchService: SearchService,
    private readonly organizer: OrganizerService,
    private readonly storage: StorageService,
    private readonly gmail: GmailSendService
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
    @Query("status") status?: string,
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
      status: status === "unread" || status === "read" ? status : undefined,
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

  /** Who a reply to this message goes to: its Reply-To (e.g. the person behind a group), else the sender. */
  @Get("missive/:id/reply-recipients")
  async replyRecipients(@Param("id") id: string) {
    const missive = await this.missive.getMissive(id);
    if (!missive) throw new NotFoundException("No such message");
    const replyTo = missive.replyTo?.length ? missive.replyTo : await this.gmail.replyToOf(missive);
    return { to: replyRecipients(missive.from, replyTo) };
  }

  /** Opening a thread marks it read; "Mark as unread" sends read: false. Mirrored to Gmail. */
  @Post("thread/:id/read")
  async markThreadRead(@Param("id") id: string, @Body() body: { read?: boolean }) {
    const read = body?.read !== false;
    const changed = await this.storage.setThreadRead(id, read);
    if (changed.length) void this.gmail.mirrorRead(changed, read);
    return { changed: changed.length };
  }

  /** "Mark all as read" for a folder. */
  @Post("folder/:slug/read-all")
  async markFolderRead(@Param("slug") slug: string) {
    const changed = await this.storage.markFolderRead(slug);
    if (changed.length) void this.gmail.mirrorRead(changed, true);
    return { changed: changed.length };
  }

  @Get("translate/languages")
  languages() {
    return Object.entries(LANGUAGES).map(([code, name]) => ({ code, name }));
  }

  /** The message in another language (the "Translate" link under a message). */
  @Post("missive/:id/translate")
  async translate(@Param("id") id: string, @Body() body: { to?: string }) {
    const missive = await this.missive.getMissive(id);
    if (!missive) throw new NotFoundException("No such message");
    try {
      return await translate(missive, body?.to ?? "en");
    } catch (e) {
      if (e instanceof WritingError) throw new HttpException(e.message, e.status);
      throw e;
    }
  }

  /**
   * "Write with AI" in the compose window: a draft of a reply (with its
   * thread, read as the signed-in user) or of a new email. Nothing is sent.
   */
  @Post("draft")
  async draft(
    @Body() body: { instructions?: string; replyTo?: string; to?: string; subject?: string; current?: string; fromName?: string; hasSignature?: boolean }
  ) {
    let thread: Awaited<ReturnType<MissiveService["getThreadMissives"]>> = [];
    if (body?.replyTo) {
      const original = await this.missive.getMissive(body.replyTo);
      if (!original) throw new NotFoundException("No such message");
      thread = (await this.missive.getThreadMissives(original.threadId)).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
      // Up to the message being answered, which may not be the newest.
      const at = thread.findIndex((m) => m.id === original.id);
      if (at >= 0) thread = thread.slice(0, at + 1);
      if (!thread.length) thread = [original];
    }
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    try {
      return await draft({
        instructions: str(body?.instructions) ?? "",
        thread,
        to: str(body?.to),
        subject: str(body?.subject),
        current: str(body?.current),
        hasSignature: body?.hasSignature === true,
        fromName: (str(body?.fromName) || requireUser().name || nameFromEmail(requireUser().email))?.slice(0, 120),
      });
    } catch (e) {
      if (e instanceof WritingError) throw new HttpException(e.message, e.status);
      throw e;
    }
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