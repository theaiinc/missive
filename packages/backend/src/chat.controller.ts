import {
  Controller,
  Post,
  Body,
  Res,
  HttpStatus,
} from "@nestjs/common";
import { ChatService, type ChatMessage } from "./chat.service";
import type { Response } from "express";

@Controller("api/v1/chat")
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post("stream")
  async streamChat(
    @Body() body: { message: string },
    @Res() res: Response
  ) {
    if (!body.message?.trim()) {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const messages: ChatMessage[] = [
      { role: "user", content: body.message },
    ];

    try {
      await this.chat.streamChat(messages, res);
    } catch {
      if (!res.headersSent) {
        res
          .status(HttpStatus.BAD_GATEWAY)
          .json({ error: "Chat service unavailable. Is LM Studio running?" });
      } else {
        try {
          res.write(`data: ${JSON.stringify({ error: "Chat error" })}\n\n`);
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        } catch {}
        try { res.end(); } catch {}
      }
    }
  }

  @Post("rule-proposal")
  async proposeRule(@Body() body: { message: string }) {
    if (!body.message?.trim()) {
      return { error: "message is required" };
    }

    return this.chat.proposeRule(body.message);
  }
}
