import { Injectable } from "@nestjs/common";
import { currentUser } from "./request-context";

export interface SystemEvent {
  id: string;
  type: "organizer" | "digest" | "sync" | "rules" | "move";
  message: string;
  createdAt: string;
}

/**
 * Events can quote a user's mail (the digest lists subjects and senders), so
 * each one belongs to the user it was produced for (jobs run as that user) and
 * is only shown to them. Events with no user carry no mail content.
 */
type StoredEvent = SystemEvent & { ownerId?: string };

const MAX_EVENTS = 50;

@Injectable()
export class SystemEventService {
  private events: StoredEvent[] = [];

  emit(type: SystemEvent["type"], message: string): void {
    const event: StoredEvent = {
      ownerId: currentUser()?.id,
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
    const mine = this.visible();
    if (!since) return mine.slice(0, 10);
    return mine.filter((e) => e.createdAt > since);
  }

  /** Get all recent events for initial load. */
  recent(limit = 10): SystemEvent[] {
    return this.visible().slice(0, limit);
  }

  /** The current user's events plus content-free system ones, without the owner field. */
  private visible(): SystemEvent[] {
    const me = currentUser()?.id;
    return this.events
      .filter((e) => !e.ownerId || e.ownerId === me)
      .map(({ ownerId: _ownerId, ...event }) => event);
  }
}
