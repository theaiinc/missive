import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { PostgresService } from "./storage/postgres.service";
import { requireUser } from "./request-context";

/** At most this many reports per person per hour: a broken page can throw in a loop. */
const PER_HOUR = 30;
const recent = new Map<string, number[]>();

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);

/**
 * Errors the web app hit (web/src/lib/report-error.ts), kept in client_errors
 * (migration 033) so a page that breaks in someone's browser or the Mac app can
 * be diagnosed without a screenshot.
 */
@Controller("api/v1/client-errors")
export class ClientErrorsController {
  constructor(private readonly pg: PostgresService) {}

  @Post()
  @HttpCode(204)
  async report(@Body() body: Record<string, unknown>): Promise<void> {
    const user = requireUser();
    const message = text(body.message, 2_000);
    if (!message) return;
    const now = Date.now();
    const times = (recent.get(user.id) ?? []).filter((t) => now - t < 3_600_000);
    if (times.length >= PER_HOUR) return;
    recent.set(user.id, [...times, now]);
    await this.pg.query(
      `INSERT INTO client_errors (kind, message, stack, component_stack, page, user_agent) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        text(body.kind, 40) ?? "error",
        message,
        text(body.stack, 8_000),
        text(body.componentStack, 8_000),
        text(body.page, 500),
        text(body.userAgent, 300),
      ],
    );
  }
}
