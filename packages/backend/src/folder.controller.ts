import { Controller, Get, Post, Body } from "@nestjs/common";
import { StorageService } from "./storage/storage.service";

@Controller("api/v1/folders")
export class FolderController {
  constructor(private readonly storage: StorageService) {}

  @Get()
  async listFolders() {
    return this.storage.listFolders();
  }

  @Post()
  async createFolder(@Body() body: { name: string; slug: string; icon?: string; color?: string }) {
    if (!body.name || !body.slug) {
      return { error: "name and slug are required" };
    }
    return this.storage.createFolder(body);
  }

  @Post("move-missive")
  async moveMissive(@Body() body: { id: string; folder: string }) {
    if (!body.id || !body.folder) {
      return { error: "id and folder are required" };
    }
    await this.storage.moveMissive(body.id, body.folder);
    return { moved: true };
  }

  @Post("move-thread")
  async moveThread(@Body() body: { threadId: string; folder: string }) {
    if (!body.threadId || !body.folder) {
      return { error: "threadId and folder are required" };
    }
    await this.storage.moveThread(body.threadId, body.folder);
    return { moved: true };
  }
}
