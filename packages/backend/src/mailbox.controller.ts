import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { timingSafeEqual } from "node:crypto";
import { MailboxService, SendError } from "./mailbox.service";
import { UsersService } from "./users.service";
import { runAsUser } from "./request-context";

const validEmail = (s: unknown): s is string => typeof s === "string" && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s);
const list = (value: unknown): string[] =>
  (Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\s]+/) : []).map((s) => String(s).trim()).filter(Boolean);

function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || secret.length < 32 || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

@Controller("api/v1")
export class MailboxController {
  constructor(
    private readonly mail: MailboxService,
    private readonly users: UsersService
  ) {}

  @Get("health")
  health() {
    return { ok: true };
  }

  /**
   * Mail for a hosted mailbox, posted by the edge Worker (Cloudflare Email
   * Routing) with INBOUND_SECRET. The body is the raw message (message/rfc822);
   * x-envelope-to names the mailbox. 404 tells the Worker to reject the mail.
   */
  @Post("inbound")
  @HttpCode(200)
  async inbound(@Req() req: Request) {
    if (!bearerMatches(req.headers.authorization, process.env.INBOUND_SECRET)) throw new UnauthorizedException();
    const to = String(req.headers["x-envelope-to"] ?? "").toLowerCase();
    const mailbox = to ? await this.users.mailbox(to) : null;
    if (!mailbox) throw new NotFoundException("No such mailbox");
    const owner = await this.users.byId(mailbox.userId);
    if (!owner) throw new NotFoundException("No such mailbox");
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new BadRequestException("Send the raw message as message/rfc822");
    const stored = await runAsUser(owner, () =>
      this.mail.receive(req.body as Buffer, mailbox, String(req.headers["x-envelope-from"] ?? ""))
    );
    return { stored };
  }

  /** Sends from one of the signed-in user's mailboxes. */
  @Post("send")
  async send(@Body() body: Record<string, unknown>) {
    const to = list(body.to);
    const cc = list(body.cc);
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const text = typeof body.text === "string" ? body.text : "";
    const problems: string[] = [];
    if (!validEmail(body.from)) problems.push("Choose a From address.");
    if (!to.length) problems.push("Add at least one recipient.");
    const bad = [...to, ...cc].filter((a) => !validEmail(a));
    if (bad.length) problems.push(`Check these addresses: ${bad.join(", ")}.`);
    if (to.length + cc.length > 50) problems.push("Send to 50 people or fewer at a time.");
    if (!subject) problems.push("Add a subject.");
    if (!text.trim()) problems.push("Write a message.");
    if (problems.length) throw new BadRequestException(problems.join(" "));
    try {
      const missive = await this.mail.send({
        from: body.from as string,
        to,
        cc,
        subject,
        text,
        replyTo: typeof body.replyTo === "string" ? body.replyTo : undefined,
      });
      return { id: missive.id, threadId: missive.threadId };
    } catch (error) {
      if (error instanceof SendError) throw new BadRequestException(error.message);
      throw error;
    }
  }
}
