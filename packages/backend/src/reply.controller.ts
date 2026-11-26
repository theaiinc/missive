import { BadRequestException, Body, ConflictException, Controller, HttpCode, NotFoundException, Post } from "@nestjs/common";
import { ReplyError, ReplyService, type ReplyExpectation } from "./reply.service";

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined);

function expectation(v: unknown): ReplyExpectation | undefined {
  if (!v || typeof v !== "object") return undefined;
  const e = v as Record<string, unknown>;
  return {
    from: typeof e.from === "string" ? e.from : undefined,
    to: strings(e.to),
    cc: strings(e.cc),
    subject: typeof e.subject === "string" ? e.subject : undefined,
  };
}

function rethrow(e: unknown): never {
  if (e instanceof ReplyError) {
    if (e.status === 404) throw new NotFoundException(e.message);
    if (e.status === 409) throw new ConflictException(e.message);
    throw new BadRequestException(e.message);
  }
  throw e;
}

/**
 * Replies to a message, addressed by Missive (reply.service.ts). For
 * assistants acting for the owner: an Aegis token reaches these only with
 * the missive:send scope (aegis-bearer.ts).
 *
 *   POST /api/v1/reply/preview { missiveId, text, replyAll? } → what would be sent
 *   POST /api/v1/reply         { missiveId, text, replyAll?, expect? } → sends it
 */
@Controller("api/v1/reply")
export class ReplyController {
  constructor(private readonly replies: ReplyService) {}

  @Post("preview")
  @HttpCode(200)
  async preview(@Body() body: Record<string, unknown>) {
    try {
      return await this.replies.plan(String(body?.missiveId ?? ""), body?.text, body?.replyAll === true);
    } catch (e) {
      rethrow(e);
    }
  }

  @Post()
  async send(@Body() body: Record<string, unknown>) {
    try {
      return await this.replies.send(String(body?.missiveId ?? ""), body?.text, body?.replyAll === true, expectation(body?.expect));
    } catch (e) {
      rethrow(e);
    }
  }
}
