import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Put, BadRequestException } from "@nestjs/common";
import { DraftsService } from "./drafts.service";
import { GroupsService } from "./groups.service";
import { GmailSendService } from "./gmail-send.service";
import { requireUser } from "./request-context";
import { isEmptyDraftPayload } from "./draft-content";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_YOURS = "Draft does not exist or belongs to another user";

type DraftBody = { mailbox?: string; payload?: Record<string, unknown>; updatedAt?: string };

/**
 * Compose drafts, each yours alone: listing, reading, saving and deleting
 * only ever reach the signed-in user's own drafts (owner_id, and row-level
 * security under it), and a draft is saved only from an address you may send
 * from: your mailbox, a group you may send as, or a connected Gmail account.
 */
@Controller("api/v1/drafts")
export class DraftsController {
  constructor(
    private readonly drafts: DraftsService,
    private readonly groups: GroupsService,
    private readonly gmail: GmailSendService,
  ) {}

  private checkId(id: string) {
    if (!UUID.test(id)) throw new BadRequestException("A draft id is a UUID");
  }

  private async validateDraftInput(body: DraftBody) {
    if (!body.mailbox || !body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      throw new BadRequestException("mailbox and payload are required");
    }
    const user = requireUser();
    const address = body.mailbox.toLowerCase();
    const mailbox = (await this.groups.addressesOf(user.id)).find((entry) => entry.address === address);
    if (!mailbox && !(await this.gmail.account(address))) {
      throw new ForbiddenException("You can only save drafts in your own mailboxes.");
    }
    return { mailbox: address, payload: body.payload };
  }

  /** Yours, newest first. */
  @Get()
  list() {
    return this.drafts.list();
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    this.checkId(id);
    const draft = await this.drafts.get(id);
    if (!draft) throw new ForbiddenException(NOT_YOURS);
    return draft;
  }

  /** Creates the draft with this id (the app picks it, so a retried save can't make a second one) or updates yours. */
  @Put(":id")
  async upsert(@Param("id") id: string, @Body() body: DraftBody) {
    this.checkId(id);
    const input = await this.validateDraftInput(body);
    // Emptying a draft you have is an edit; starting one with nothing in it isn't saved.
    if (isEmptyDraftPayload(input.payload) && !(await this.drafts.get(id))) {
      throw new BadRequestException("A draft needs a recipient, subject, message or attachment");
    }
    const saved = await this.drafts.upsert({ id, ...input, updatedAt: body.updatedAt });
    if (!saved) throw new ForbiddenException(NOT_YOURS);
    return saved;
  }

  @Put()
  async create(@Body() body: DraftBody) {
    const input = await this.validateDraftInput(body);
    if (isEmptyDraftPayload(input.payload)) {
      throw new BadRequestException("A draft needs a recipient, subject, message or attachment");
    }
    const saved = await this.drafts.upsert({ ...input, updatedAt: body.updatedAt });
    if (!saved) throw new ForbiddenException(NOT_YOURS);
    return saved;
  }

  /** Discards one of your drafts; someone else's (or one that's gone) is a 403, like reading it. */
  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string) {
    this.checkId(id);
    if (!(await this.drafts.remove(id))) throw new ForbiddenException(NOT_YOURS);
  }
}
