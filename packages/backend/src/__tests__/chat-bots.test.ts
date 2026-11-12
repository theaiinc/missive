import { describe, expect, it } from "vitest";
import { chatMissiveId, chatThreadId, fromDiscord, fromTelegram, type DiscordNames } from "../chat-bots";

const BOT = "999";

describe("fromTelegram", () => {
  it("files a group message with its group, sender and text", () => {
    const m = fromTelegram(
      {
        message_id: 42,
        date: 1_790_000_000,
        chat: { id: -1001, type: "supergroup", title: "Film Crew" },
        from: { id: 7, first_name: "Mai", last_name: "Ho" },
        text: "see you at 7",
      },
      BOT,
    );
    expect(m).toEqual({
      chatId: "-1001",
      chatTitle: "Film Crew",
      messageId: "42",
      senderId: "7",
      senderName: "Mai Ho",
      text: "see you at 7",
      fromBot: false,
      at: new Date(1_790_000_000 * 1000).toISOString(),
    });
  });

  it("names a direct message after the person, and shows media as a placeholder with its caption", () => {
    const m = fromTelegram(
      { message_id: 1, date: 1, chat: { id: 7, type: "private", first_name: "Mai" }, from: { id: 7, first_name: "Mai" }, photo: [{}], caption: "poster draft" },
      BOT,
    );
    expect(m?.chatTitle).toBe("Mai");
    expect(m?.text).toBe("[photo] poster draft");
  });

  it("marks the bot's own messages and skips service messages with nothing to show", () => {
    expect(fromTelegram({ message_id: 2, date: 1, chat: { id: 7, type: "private" }, from: { id: 999, is_bot: true }, text: "hi" }, BOT)?.fromBot).toBe(true);
    expect(fromTelegram({ message_id: 3, date: 1, chat: { id: -1, type: "group", title: "G" } }, BOT)).toBeNull();
  });
});

describe("fromDiscord", () => {
  const names: DiscordNames = { channels: new Map([["c1", "general"]]), guilds: new Map([["g1", "Cinely HQ"]]) };
  const base = { id: "m1", channel_id: "c1", timestamp: "2026-11-12T08:00:00.000Z", content: "shipped!" };

  it("titles a server message with its channel and server, and prefers the member's nickname", () => {
    const m = fromDiscord({ ...base, guild_id: "g1", author: { id: "u1", username: "jordan", global_name: "Jordan" }, member: { nick: "Jo" } }, BOT, names);
    expect(m).toMatchObject({ chatId: "c1", chatTitle: "#general · Cinely HQ", senderName: "Jo", text: "shipped!", fromBot: false });
  });

  it("titles a DM after the person and appends attachment links", () => {
    const m = fromDiscord(
      { ...base, content: "", author: { id: "u1", username: "jordan", global_name: "Jordan" }, attachments: [{ url: "https://cdn/x.png", filename: "x.png" }] },
      BOT,
      names,
    );
    expect(m?.chatTitle).toBe("Jordan");
    expect(m?.text).toBe("https://cdn/x.png");
  });

  it("skips messages with nothing to show", () => {
    expect(fromDiscord({ ...base, content: "", author: { id: "u1", username: "x" } }, BOT, names)).toBeNull();
  });
});

describe("chat ids", () => {
  it("are stable, and differ per owner, app and chat", () => {
    expect(chatThreadId("u1", "telegram", "-1001")).toBe(chatThreadId("u1", "telegram", "-1001"));
    expect(chatThreadId("u1", "telegram", "-1001")).not.toBe(chatThreadId("u2", "telegram", "-1001"));
    expect(chatThreadId("u1", "telegram", "1")).not.toBe(chatThreadId("u1", "discord", "1"));
    expect(chatMissiveId("u1", "discord", "c1", "m1")).toMatch(/^m_[0-9a-f]{26}$/);
  });
});
