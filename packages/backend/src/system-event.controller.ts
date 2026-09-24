import { Controller, Get, Query } from "@nestjs/common";
import { SystemEventService } from "./system-event.service";

@Controller("api/v1/system-events")
export class SystemEventController {
  constructor(private readonly events: SystemEventService) {}

  @Get()
  async list(@Query("since") since?: string) {
    return this.events.poll(since ?? undefined);
  }
}
