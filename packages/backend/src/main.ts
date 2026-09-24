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