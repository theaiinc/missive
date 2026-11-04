import { Body, Controller, Delete, Get, Param, Put } from "@nestjs/common";
import { DraftsService } from "./drafts.service";

@Controller("api/v1/drafts")
export class DraftsController {
  constructor(private readonly drafts: DraftsService) {}

  @Get()
  list() {
    return this.drafts.list();
  }

  @Put(":id")
  upsert(@Param("id") id: string, @Body() body: { mailbox?: string; payload?: Record<string, unknown>; updatedAt?: string }) {
    if (!body.mailbox || !body.payload || typeof body.payload !== "object") {
      throw new Error("mailbox and payload are required");
    }
    return this.drafts.upsert({ id, mailbox: body.mailbox, payload: body.payload, updatedAt: body.updatedAt });
  }

  @Put()
  create(@Body() body: { mailbox?: string; payload?: Record<string, unknown>; updatedAt?: string }) {
    if (!body.mailbox || !body.payload || typeof body.payload !== "object") {
      throw new Error("mailbox and payload are required");
    }
    return this.drafts.upsert({ mailbox: body.mailbox, payload: body.payload, updatedAt: body.updatedAt });
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.drafts.remove(id);
  }
}