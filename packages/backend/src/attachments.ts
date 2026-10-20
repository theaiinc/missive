import type { ParsedMail } from "mailparser";
import type { IncomingAttachment } from "./storage/storage.service";

/**
 * The files a parsed message carries (hosted mailboxes, IMAP). Pictures the
 * HTML shows through cid: links are part of the body, not attachments:
 * mailparser puts those into the HTML itself and marks them `related`.
 */
export function fromParsedMail(parsed: ParsedMail): IncomingAttachment[] {
  return (parsed.attachments ?? [])
    .filter((a) => !a.related)
    .map((a) => ({ filename: a.filename || "attachment", mimeType: a.contentType || "application/octet-stream", content: a.content }));
}
