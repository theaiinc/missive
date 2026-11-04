import { Body, Controller, Delete, ForbiddenException, Get, Param, Put, BadRequestException } from "@nestjs/common";
import { DraftsService } from "./drafts.service";
import { GroupsService } from "./groups.service";
import { requireUser } from "./request-context";

@Controller("api/v1/drafts")
export class DraftsController {
  constructor(private readonly drafts: DraftsService, private readonly groups: GroupsService) {}

  private async validateDraftInput(body: { mailbox?: string; payload?: Record<string, unknown> }) {
    if (!body.mailbox || !body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      throw new BadRequestException("mailbox and payload are required");
    }
    const user = requireUser();
    const mailbox = (await this.groups.addressesOf(user.id)).find((entry) => entry.address === body.mailbox!.toLowerCase());
    if (!mailbox) throw new ForbiddenException("You can only save drafts in your own mailboxes.");
    return { mailbox: mailbox.address, payload: body.payload };
  }

  @Get()
  list() {
    return this.drafts.list();
  }

  @Put(":id")
  async upsert(@Param("id") id: string, @Body() body: { mailbox?: string; payload?: Record<string, unknown>; updatedAt?: string }) {
    const input = await this.validateDraftInput(body);
    return this.drafts.upsert({ id, ...input, updatedAt: body.updatedAt });
  }

  @Put()
  async create(@Body() body: { mailbox?: string; payload?: Record<string, unknown>; updatedAt?: string }) {
    const input = await this.validateDraftInput(body);
    return this.drafts.upsert({ ...input, updatedAt: body.updatedAt });
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.drafts.remove(id);
  }
}