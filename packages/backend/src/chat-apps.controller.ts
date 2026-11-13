import { All, Body, Controller, Delete, Get, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { ChatAppsService, type HookInput } from "./chat-apps.service";

/**
 * Chat apps (Telegram, Discord): connecting bots and the Chat page's
 * conversations. (api/v1/chat is the AI assistant.) A conversation's messages
 * come from GET api/v1/thread/:id/missives and it's marked read with
 * POST api/v1/thread/:id/read, like any thread.
 */
@Controller("api/v1/chat-apps")
export class ChatAppsController {
  constructor(private readonly chatApps: ChatAppsService) {}

  @Get("accounts")
  accounts() {
    return this.chatApps.accounts();
  }

  @Post("connect")
  connect(@Body() body: { provider: string; token?: string; label?: string; credentials?: HookInput }) {
    return this.chatApps.connect(body?.provider, body?.token ?? "", body?.label ?? "", body?.credentials);
  }

  @Delete("accounts/:id")
  async disconnect(@Param("id") id: string) {
    await this.chatApps.disconnect(id);
    return { disconnected: true };
  }

  @Get("conversations")
  conversations() {
    return this.chatApps.conversations();
  }

  @Post("conversations/:id/send")
  send(@Param("id") id: string, @Body() body: { text: string }) {
    return this.chatApps.send(id, body?.text);
  }
}

/**
 * Webhooks WeCom and Zalo call (public: see auth.middleware.ts). The key in
 * the path picks the connection; ChatAppsService.hook checks each call's
 * signature with that connection's secret before filing anything.
 */
@Controller("api/v1/hooks")
export class ChatHooksController {
  constructor(private readonly chatApps: ChatAppsService) {}

  @All(":provider/:key")
  async hook(@Param("provider") provider: string, @Param("key") key: string, @Req() req: Request, @Res() res: Response) {
    const body =
      typeof (req as any).rawBody === "string" ? (req as any).rawBody : typeof req.body === "string" ? req.body : "";
    const reply = await this.chatApps.hook(provider, key, {
      method: req.method,
      query: req.query as Record<string, string | undefined>,
      body,
      signature: req.header("x-zevent-signature") ?? undefined,
    });
    res.status(reply.status).type("text/plain").send(reply.body);
  }
}
