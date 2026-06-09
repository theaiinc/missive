import { Controller, Get } from "@nestjs/common";
import { OrganizerService } from "./organizer.service";

@Controller("api/v1")
export class DigestController {
  constructor(private readonly organizer: OrganizerService) {}

  @Get("digest")
  async getDigest() {
    // Only return the latest cached digest — never generate on-demand
    // to avoid blocking the frontend poll. Generation happens in the scheduler.
    const latest = await this.organizer.getLatestDigest();
    return latest ?? { id: null, summary: "No digest yet.", items: [], periodStart: "", periodEnd: "", missiveCount: 0, createdAt: "" };
  }
}
