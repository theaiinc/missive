import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { buildMime } from "../gmail-send.service";
import { fromParsedMail } from "../attachments";

const pdf = Buffer.from("%PDF-1.4 a tiny pdf");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);

describe("buildMime with attachments", () => {
  it("is a message any mail app reads back: text, HTML and each file", async () => {
    const raw = buildMime({
      from: "me@example.com",
      to: ["you@example.com"],
      subject: "Invoice",
      text: "See attached.",
      html: "<p>See attached.</p>",
      attachments: [
        { filename: "invoice.pdf", mimeType: "application/pdf", content: pdf },
        { filename: "Ảnh chụp.png", mimeType: "image/png", content: png },
      ],
    });
    const parsed = await simpleParser(raw);
    expect(parsed.text?.trim()).toBe("See attached.");
    expect(String(parsed.html)).toContain("<p>See attached.</p>");
    expect(parsed.attachments.map((a) => [a.filename, a.contentType])).toEqual([
      ["invoice.pdf", "application/pdf"],
      ["Ảnh chụp.png", "image/png"],
    ]);
    expect(parsed.attachments[0]!.content.equals(pdf)).toBe(true);
    expect(parsed.attachments[1]!.content.equals(png)).toBe(true);
  });

  it("stays a plain text-and-HTML message without files", () => {
    const raw = buildMime({ from: "me@example.com", to: ["you@example.com"], subject: "Hi", text: "Hi", html: "<p>Hi</p>" });
    expect(raw).toContain("multipart/alternative");
    expect(raw).not.toContain("multipart/mixed");
  });
});

describe("fromParsedMail", () => {
  it("keeps files, not the pictures the HTML shows inline", async () => {
    const raw = [
      "From: a@example.com",
      "To: b@example.com",
      "Subject: x",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="m"',
      "",
      "--m",
      'Content-Type: multipart/related; boundary="r"',
      "",
      "--r",
      "Content-Type: text/html",
      "",
      '<p>Logo <img src="cid:logo@x"></p>',
      "--r",
      "Content-Type: image/png",
      "Content-ID: <logo@x>",
      "Content-Transfer-Encoding: base64",
      "",
      png.toString("base64"),
      "--r--",
      "--m",
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      pdf.toString("base64"),
      "--m--",
      "",
    ].join("\r\n");
    const files = fromParsedMail(await simpleParser(raw));
    expect(files.map((f) => f.filename)).toEqual(["report.pdf"]);
    expect(files[0]!.content.equals(pdf)).toBe(true);
  });
});
