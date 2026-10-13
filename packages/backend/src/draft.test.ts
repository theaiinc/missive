import { afterEach, describe, expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import { draft, MAX_THREAD_CHARS, nameFromEmail, threadContext } from "./draft";
import { buildMime } from "./gmail-send.service";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const answer = (content: string) =>
  vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content } }] })));

const msg = (body: string, from = "an@example.com", direction: "inbound" | "outbound" = "inbound", receivedAt = "2026-10-13T01:00:00Z") => ({
  from: { address: from, name: "An" },
  subject: "Cuộc họp",
  body,
  bodyHtml: undefined,
  receivedAt,
  direction,
});

describe("draft", () => {
  it("keeps the newest messages of a long thread, oldest first", () => {
    const thread = [msg("old ".repeat(2_000), "a@x.com"), msg("middle", "b@x.com", "outbound"), msg("newest", "c@x.com")];
    const text = threadContext(thread);
    expect(text.length).toBeLessThanOrEqual(MAX_THREAD_CHARS + 200);
    expect(text.indexOf("middle")).toBeLessThan(text.indexOf("newest"));
    expect(text).toContain('from="Me"');
  });

  it("drafts a reply from the thread and the instruction, on the writing model", async () => {
    vi.stubEnv("LM_STUDIO_BASE_URL", "https://mail.example/internal/ai/v1");
    vi.stubEnv("LM_STUDIO_WRITING_MODEL", "@cf/google/gemma-4-26b-a4b-it");
    const fetch = answer("<subject>Re: Cuộc họp</subject>\n<body>Chào An,\n\nThứ Năm 3 giờ chiều được nhé.\n\nSteve</body>");
    vi.stubGlobal("fetch", fetch);
    const out = await draft({ instructions: "accept, Thursday 3pm", thread: [msg("Họp tuần này được không?")], fromName: "Steve" });
    expect(out).toEqual({ subject: "Re: Cuộc họp", text: "Chào An,\n\nThứ Năm 3 giờ chiều được nhé.\n\nSteve" });
    const sent = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(sent.model).toBe("@cf/google/gemma-4-26b-a4b-it");
    expect(sent.messages[0].content).toContain("reply");
    expect(sent.messages[1].content).toContain("Họp tuần này được không?");
    expect(sent.messages[1].content).toContain("<instructions>accept, Thursday 3pm</instructions>");
  });

  it("names the sender from their address when the account has no name", () => {
    expect(nameFromEmail("steve.tran@theaiinc.com")).toBe("Steve Tran");
    expect(nameFromEmail("an_nguyen2@x.com")).toBe("An Nguyen");
  });

  it("needs an instruction for a new email", async () => {
    const fetch = answer("x");
    vi.stubGlobal("fetch", fetch);
    await expect(draft({ instructions: "  ", thread: [] })).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("gmail send", () => {
  it("builds a reply Gmail threads, with non-ASCII subject and body intact", async () => {
    const raw = buildMime({
      from: "steve@example.com",
      fromName: "Steve Trần",
      to: ["an@example.com"],
      subject: "Re: Cuộc họp",
      text: "Được nhé",
      html: "<p>Được nhé</p>",
      inReplyTo: "<abc@mail.example>",
      references: "<root@mail.example> <abc@mail.example>",
    });
    const parsed = await simpleParser(raw);
    expect(parsed.subject).toBe("Re: Cuộc họp");
    expect(parsed.from?.value[0]).toMatchObject({ address: "steve@example.com", name: "Steve Trần" });
    expect(parsed.inReplyTo).toBe("<abc@mail.example>");
    expect(parsed.text?.trim()).toBe("Được nhé");
    expect(String(parsed.html)).toContain("Được nhé");
  });
});

describe("read receipts and images", () => {
  it("asks for a read receipt only when told to", async () => {
    const base = { from: "steve@example.com", to: ["an@example.com"], subject: "Hi", text: "x", html: "<p>x</p>" };
    expect(buildMime(base)).not.toContain("Disposition-Notification-To");
    expect(buildMime({ ...base, readReceipt: true })).toContain("Disposition-Notification-To: steve@example.com");
  });

  it("signs image links the edge can check, and only http(s) ones", async () => {
    const { signImageUrl } = await import("./images");
    const { createHmac } = await import("node:crypto");
    const link = new URL(signImageUrl("https://t.example/p.gif?id=1", "s".repeat(40), Date.UTC(2026, 9, 13, 10, 20)), "https://m.example");
    const e = link.searchParams.get("e")!;
    expect(Number(e) % 3600).toBe(0);
    expect(link.searchParams.get("s")).toBe(createHmac("sha256", "s".repeat(40)).update(`https://t.example/p.gif?id=1|${e}`).digest("hex"));
  });
});

describe("reply recipients", () => {
  it("reads Reply-To headers, quoted names with commas included", async () => {
    const { parseAddressList } = await import("./addresses");
    expect(parseAddressList('"Yao, Zhiheng" <Yao@Volc.example>, b@x.com, not-an-address')).toEqual([
      { address: "yao@volc.example", name: "Yao, Zhiheng" },
      { address: "b@x.com" },
    ]);
    expect(parseAddressList(undefined)).toEqual([]);
  });

  it("answers the Reply-To when it differs from the sender, else the sender", async () => {
    const { replyRecipients } = await import("./addresses");
    const group = { address: "info@theaiinc.com", name: "via info" };
    expect(replyRecipients(group, [{ address: "yao@volc.example" }])).toEqual([{ address: "yao@volc.example" }]);
    expect(replyRecipients(group, [{ address: "INFO@theaiinc.com" }])).toEqual([group]);
    expect(replyRecipients(group, undefined)).toEqual([group]);
  });
});
