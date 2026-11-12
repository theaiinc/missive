import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { ChatAppsService } from "./chat-apps.service";

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
  connect(@Body() body: { provider: string; token: string; label?: string }) {
    return this.chatApps.connect(body?.provider, body?.token, body?.label ?? "");
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
