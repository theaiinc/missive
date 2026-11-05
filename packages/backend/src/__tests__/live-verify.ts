import assert from "node:assert/strict";

const baseUrl = process.env.BASE_URL ?? "https://missive.theaiinc.com";
const token = process.env.MISSIVE_TOKEN;
const ownedMailbox = process.env.OWNED_MAILBOX;
const foreignMailbox = process.env.FOREIGN_MAILBOX;

if (!token || !ownedMailbox || !foreignMailbox) {
  throw new Error("Set MISSIVE_TOKEN, OWNED_MAILBOX, and FOREIGN_MAILBOX in the execution environment.");
}

const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

async function request(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
}

const formattedHtml =
  '<p><strong>synthetic bold</strong> <a href="https://example.test/synthetic">synthetic link</a></p><ul><li>synthetic list</li></ul>';

const sendResponse = await request("/api/v1/send", {
  method: "POST",
  body: JSON.stringify({
    from: ownedMailbox,
    to: [ownedMailbox],
    subject: "Synthetic formatting verification",
    html: formattedHtml,
    text: "synthetic bold synthetic link synthetic list",
  }),
});
assert.equal(sendResponse.ok, true, `send failed: ${sendResponse.status}`);
const sent = (await sendResponse.json()) as { id?: string; messageId?: string };
const messageId = sent.messageId ?? sent.id;
assert.ok(messageId, "send response did not include a message id");

const messageResponse = await request(`/api/v1/messages/${encodeURIComponent(messageId)}`);
assert.equal(messageResponse.ok, true, `message fetch failed: ${messageResponse.status}`);
const message = (await messageResponse.json()) as Record<string, unknown>;
const storedHtml = String(message.html ?? message.bodyHtml ?? (message.body as Record<string, unknown> | undefined)?.html ?? "");
assert.match(storedHtml, /<strong>/);
assert.match(storedHtml, /<a href="https:\/\/example\.test\/synthetic">/);
assert.match(storedHtml, /<