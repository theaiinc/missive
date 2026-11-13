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
  exitOnSignals(() => app.close());
}

/**
 * Exits on SIGTERM/SIGINT, after closing the app for at most 5 seconds. In
 * the container `node` is PID 1, which the kernel never kills for a signal it
 * has no handler for, so without this the edge Worker's restart for a new
 * deploy (packages/edge/src/rollout.ts) and Cloudflare's rollout were ignored
 * and the old build kept serving until the platform gave up waiting.
 */
export function exitOnSignals(close: () => Promise<unknown>, exit: (code: number) => void = (code) => process.exit(code), graceMs = 5_000): void {
  let closing = false;
  const stop = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: shutting down`);
    const timer = setTimeout(() => exit(0), graceMs);
    timer.unref?.();
    close().then(
      () => exit(0),
      (error: unknown) => {
        console.error("Shutdown failed", error);
        exit(0);
      }
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (require.main === module) bootstrap();