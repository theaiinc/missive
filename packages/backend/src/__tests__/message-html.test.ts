import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { buildMime } from "../gmail-send.service";
import { MailboxController } from "../mailbox.controller";
import { htmlToText, messageBody, sanitizeHtml, textToHtml } from "../message-html";

/** What the Compose editor sends for a formatted reply with a signature and quote. */
const composed =
  '<p>Hi An,</p><p>Here is <strong>the plan</strong>, <em>roughly</em>: see <a href="https://example.com/plan">the doc</a>.</p>' +
  "<ul><li><p>Draft</p></li><li><p>Review</p></li></ul>" +
  "<ol><li><p>Monday</p></li><li><p>Tuesday</p></li></ol>" +
  "<p>-- <br>Steve Tran<br>The AI Inc</p>" +
  "<p>On Mon, An wrote:<br>&gt; Can you send the plan?</p>";

describe("sanitizeHtml", () => {
  it("keeps bold, italics, links and lists, with styles mail apps show", () => {
    const html = sanitizeHtml(composed);
    expect(html).toContain("<strong>the plan</strong>");
    expect(html).toContain("<em>roughly</em>");
    expect(html).toContain('<a href="https://example.com/plan" target="_blank" rel="noopener noreferrer">the doc</a>');
    expect(html).toMatch(/<ul style="[^"]+"><li style="[^"]+"><p style="margin:0">Draft<\/p><\/li>/);
    expect(html).toMatch(/<ol style="[^"]+">/);
    expect(html).toContain("Steve Tran<br>The AI Inc");
    expect(html).toContain("&gt; Can you send the plan?");
  });

  it("drops scripts, styles, frames and their contents", () => {
    const html = sanitizeHtml('<p>a<script>alert(1)</script>b</p><style>p{}</style><iframe src="https://x"></iframe><svg><text>s</text></svg>c');
    expect(html).toBe('<p style="margin:0 0 14px">ab</p>c');
  });

  it("drops event handlers, style and class attributes, and images", () => {
    const html = sanitizeHtml('<p onclick="x()" style="color:red" class="c">hi<img src="https://t/p.gif" onerror="x()"></p>');
    expect(html).toBe('<p style="margin:0 0 14px">hi</p>');
  });

  it("keeps a link's text but not an unsafe target", () => {
    for (const href of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "/relative"]) {
      expect(sanitizeHtml(`<a href="${href}">click</a>`)).toBe("click");
    }
    expect(sanitizeHtml('<a href="mailto:an@example.com">mail</a>')).toContain('href="mailto:an@example.com"');
    expect(sanitizeHtml('<a>no href</a>')).toBe("no href");
  });

  it("escapes text and attribute values", () => {
    expect(sanitizeHtml("<p>1 &lt; 2 &amp; &lt;b&gt;</p>")).toBe('<p style="margin:0 0 14px">1 &lt; 2 &amp; &lt;b&gt;</p>');
    expect(sanitizeHtml('<a href="https://x.com/?a=1&amp;b=&quot;2&quot;">x</a>')).toContain('href="https://x.com/?a=1&amp;b=&quot;2&quot;"');
  });

  it("closes what it opens, even from broken HTML", () => {
    expect(sanitizeHtml("<p><strong>bold <em>both</p>after")).toBe('<p style="margin:0 0 14px"><strong>bold <em>both</em></strong></p>after');
    expect(sanitizeHtml("</ul></em>text<b>open")).toBe("text<b>open</b>");
  });

  it("keeps an ordered list's start number and nothing else", () => {
    expect(sanitizeHtml('<ol start="3" type="a"><li>x</li></ol>')).toMatch(/^<ol start="3" style="[^"]+">/);
    expect(sanitizeHtml('<ol start="3 onclick=x"><li>x</li></ol>')).toMatch(/^<ol style="[^"]+">/);
  });
});

describe("htmlToText", () => {
  it("keeps bullets, numbers and where links go", () => {
    const text = htmlToText(sanitizeHtml(composed));
    expect(text).toContain("Here is the plan, roughly: see the doc [https://example.com/plan].");
    expect(text).toMatch(/\* Draft\n \* Review/);
    expect(text).toMatch(/1\. Monday\n 2\. Tuesday/);
    expect(text).toContain("-- \nSteve Tran\nThe AI Inc");
    expect(text).toContain("> Can you send the plan?");
  });
});

describe("messageBody", () => {
  it("with only text, is the plain message in paragraphs (AI drafts, API callers)", () => {
    const { text, html } = messageBody({ text: "Hi <An>,\n\nLine one\nline two" });
    expect(text).toBe("Hi <An>,\n\nLine one\nline two");
    expect(html).toBe(textToHtml(text));
    expect(html).toContain("Hi &lt;An&gt;,</p>");
    expect(html).toContain("Line one<br>line two");
  });

  it("with html, sends it sanitized and makes the text part from it", () => {
    const { text, html } = messageBody({ text: "ignored", html: `${composed}<script>steal()</script>` });
    expect(html).not.toContain("script");
    expect(html).not.toContain("steal");
    expect(html).toMatch(/^<div style="font:[^"]+"><p/);
    expect(text).not.toContain("ignored");
    expect(text).toContain("Hi An,");
  });

  it("comes out of the MIME as both parts a mail app shows", async () => {
    const { text, html } = messageBody({ text: "", html: composed });
    const parsed = await simpleParser(buildMime({ from: "me@example.com", to: ["an@example.com"], subject: "Plan", text, html }));
    expect(parsed.text).toContain("* Draft");
    expect(String(parsed.html)).toContain("<strong>the plan</strong>");
    expect(String(parsed.html)).toContain('href="https://example.com/plan"');
  });
});

describe("POST send", () => {
  const sent = () => {
    const calls: { via: string; mail: { text: string; html?: string } }[] = [];
    const missive = { id: "m_1", threadId: "t_1" };
    const make = (gmailAccount: boolean) =>
      new MailboxController(
        { send: async (mail: never) => (calls.push({ via: "hosted", mail }), missive) } as never,
        {} as never,
        {} as never,
        { account: async () => gmailAccount, send: async (mail: never) => (calls.push({ via: "gmail", mail }), missive) } as never
      );
    return { calls, make };
  };
  const request = { from: "me@example.com", to: "an@example.com", subject: "Plan" };

  for (const [via, gmail] of [["gmail", true], ["hosted", false]] as const) {
    it(`sends formatted mail through ${via}, sanitized, with a text part`, async () => {
      const { calls, make } = sent();
      await make(gmail).send({ ...request, text: "Hi An, here is the plan", html: `${composed}<img src=x onerror=alert(1)>` });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.via).toBe(via);
      expect(calls[0]!.mail.html).toContain("<strong>the plan</strong>");
      expect(calls[0]!.mail.html).not.toMatch(/img|onerror/);
      expect(calls[0]!.mail.text).toContain(" * Draft");
    });

    it(`still sends plain text through ${via}`, async () => {
      const { calls, make } = sent();
      await make(gmail).send({ ...request, text: "Hi An,\n\n**not bold**" });
      expect(calls[0]!.mail.text).toBe("Hi An,\n\n**not bold**");
      expect(calls[0]!.mail.html).toBe(textToHtml("Hi An,\n\n**not bold**"));
    });
  }

  it("refuses formatting with nothing written", async () => {
    const { make } = sent();
    await expect(make(false).send({ ...request, text: "", html: "<p><br></p><script>x</script>" })).rejects.toThrow("Write a message.");
  });
});
