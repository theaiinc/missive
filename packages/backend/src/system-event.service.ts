import { Injectable } from "@nestjs/common";

export interface SystemEvent {
  id: string;
  type: "organizer" | "digest" | "sync" | "rules" | "move";
  message: string;
  createdAt: string;
}

const MAX_EVENTS = 50;

@Injectable()
export class SystemEventService {
  private events: SystemEvent[] = [];

  emit(type: SystemEvent["type"], message: string): void {
    const event: SystemEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      message,
      createdAt: new Date().toISOString(),
    };
    this.events.unshift(event);
    // Keep only the last MAX_EVENTS
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(0, MAX_EVENTS);
    }
  }

  /** Get events since a given timestamp (ISO string). */
  poll(since?: string): SystemEvent[] {
    if (!since) return this.events.slice(0, 10);
    return this.events.filter((e) => e.createdAt > since);
  }

  /** Get all recent events for initial load. */
  recent(limit = 10): SystemEvent[] {
    return this.events.slice(0, limit);
  }
}
