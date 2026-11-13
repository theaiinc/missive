import { describe, expect, it } from "vitest";
import type { Missive } from "@theaiinc/missive-core";
import { chatNotification, chatSender, mailNotification } from "../notification-text";

const chat = (over: Partial<Missive> = {}): Missive =>
  ({
    id: "m_1",
    threadId: "t_abc",
    channel: "chat",
    direction: "inbound",
    provider: "zalo",
    subject: "Zalo user ···4897",
    body: "Is this in stock?",
    from: { name: "Zalo user ···4897", address: "zalo:5387598391981684897" },
    to: [],
    status: "unread",
    folder: "chat",
    accountEmail: "1234567890",
    receivedAt: "2026-11-13T00:00:00.000Z",
    createdAt: "2026-11-13T00:00:00.000Z",
    updatedAt: "2026-11-13T00:00:00.000Z",
    ...over,
  }) as Missive;

describe("chatNotification", () => {
  it("says the app and connection for a one-to-one chat, then who wrote and what", () => {
    expect(chatNotification(chat(), { connection: "Neko Coffee" })).toEqual({
      title: "Zalo · Neko Coffee",
      body: "Zalo user ···4897: Is this in stock?",
      url: "/chat/t_abc",
      tag: "chat:t_abc",
    });
  });

  it("never shows a bare id, from older messages filed before names", () => {
    const n = chatNotification(chat({ subject: "5387598391981684897", from: { name: "5387598391981684897", address: "zalo:5387598391981684897" } }), { connection: "Neko Coffee" });
    expect(n.title).toBe("Zalo · Neko Coffee");
    expect(n.body).toBe("Zalo user ···4897: Is this in stock?");
    expect(chatSender({ provider: "zalo", from: { address: "zalo:5387598391981684897" } })).toBe("Zalo user ···4897");
  });

  it("names a group after the group, and counts what's waiting in it", () => {
    const n = chatNotification(chat({ provider: "telegram", subject: "Film Crew", from: { name: "Mai Ho", address: "telegram:7" }, body: "see you\n at 7" }), { connection: "Missive bot", unread: 3 });
    expect(n.title).toBe("Telegram · Film Crew (3 new)");
    expect(n.body).toBe("Mai Ho: see you at 7");
  });

  it("clips long messages and stands in for empty ones", () => {
    expect(chatNotification(chat({ body: "x".repeat(500) })).body.length).toBeLessThan(220);
    expect(chatNotification(chat({ body: "" })).body).toBe("Zalo user ···4897: (no text)");
    expect(chatNotification(chat()).title).toBe("Zalo");
  });
});

describe("mailNotification", () => {
  it("opens the thread", () => {
    const n = mailNotification(chat({ channel: "email", threadId: "thr 1", subject: "Invoice", from: { name: "Ana", address: "ana@x.com" } }));
    expect(n).toEqual({ title: "Ana", body: "Invoice", url: "/thread/thr%201", tag: "thread:thr 1" });
  });
});
