import "reflect-metadata";
import * as dotenv from "dotenv";
import * as path from "path";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { JsonExceptionFilter } from "./json-exception.filter";

// Load .env from monorepo root before Nest boots
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Hosted behind the edge Worker, which is the only public entry point.
  app.set("trust proxy", true);
  // Inbound mail arrives as the raw message (see MailboxController.inbound).
  app.useBodyParser("raw", { type: "message/rfc822", limit: "40mb" });
  // Calendar imports arrive as the .ics file itself (see CalendarController.importIcs).
  app.useBodyParser("text", { type: "text/calendar", limit: "10mb" });
  // Sending carries its attachments as base64 (up to 25 MB of files, ~34 MB encoded).
  // Chat app webhooks: WeCom posts XML, and Zalo signs the exact JSON it sent,
  // so the raw text is kept for checking (ChatHooksController).
  app.useBodyParser("text", { type: ["text/xml", "application/xml"], limit: "1mb" });
  app.useBodyParser("json", {
    limit: "40mb",
    verify: (req: any, _res: unknown, buf: Buffer) => {
      if (String(req.url ?? "").startsWith("/api/v1/hooks/")) req.rawBody = buf.toString("utf8");
    },
  });

  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  });

  // Ensure all errors are returned as JSON
  app.useGlobalFilters(new JsonExceptionFilter());

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  console.log(`Missive API running on http://localhost:${port}`);
}

bootstrap();