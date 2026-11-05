# Deployed API verification

This runbook uses only synthetic content and an owned test mailbox. Set `BASE_URL` to `https://missive.theaiinc.com` and provide an authenticated bearer token through `MISSIVE_TOKEN`; never print the token.

## Preconditions

```sh
export BASE_URL=https://missive.theaiinc.com
export AUTH="Authorization: Bearer $MISSIVE_TOKEN"
export OWNED_MAILBOX='owned-test-mailbox@example.test'
export FOREIGN_MAILBOX='someone-elses-mailbox@example.test'
```

The mailbox values above are placeholders and must be replaced only with synthetic test mailboxes owned by the authenticated test account. Do not use customer addresses.

## (a) Formatted send and received HTML

Use the deployed send endpoint with synthetic content:

```sh
curl -sS -D /tmp/send.headers \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/v1/send" \
  --data-binary @- <<'JSON' | tee /tmp/send.json
{
  "from": "owned-test-mailbox@example.test",
  "to": ["owned-test-mailbox@example.test"],
  "subject": "Missive synthetic formatting verification",
  "html": "<p><strong>bold verification</strong> <a href=\"https://example.test/synthetic\">synthetic link</a></p><ul><li>synthetic list item</li></ul>",
  "text": "bold verification synthetic link synthetic list item"
}
JSON
```

Record only the HTTP status and the returned synthetic message identifier:

```sh
awk 'NR==1 {print}' /tmp/send.headers
jq '{id, messageId, threadId}' /tmp/send.json
```

Fetch the received message using the deployed message-read route identified by the API response, then inspect only the HTML markers:

```sh
curl -sS -H "$AUTH" "$BASE_URL/api/v1/messages/$MESSAGE_ID" > /tmp/received.json
jq -r '.html // .bodyHtml // .body.html // ""' /tmp/received.json |
  grep -oE '<strong>|<a href="[^"]+">|<ul><li>' |
  sort -u
```

Expected redacted output:

```text
<strong>
<a href="https://example.test/synthetic">
<ul><li>
```

## (b) Draft round trip and mailbox authorization

Create a synthetic formatted draft:

```sh
curl -sS -D /tmp/draft.headers \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/v1/drafts" \
  --data-binary @- <<'JSON' | tee /tmp/draft.json
{
  "mailbox": "owned-test-mailbox@example.test",
  "payload": {
    "to": ["owned-test-mailbox@example.test"],
    "subject": "Synthetic draft verification",
    "html": "<p><strong>draft bold</strong> <a href=\"https://example.test/draft\">draft link</a></p><ul><li>draft item</li></ul>",
    "text": "draft bold draft link draft item"
  }
}
JSON
```

Record status and only non-sensitive fields:

```sh
awk 'NR==1 {print}' /tmp/draft.headers
jq '{id, mailbox, payload: {subject, html, text}}' /tmp/draft.json
```

Fetch the returned draft identifier to simulate reopening the tab:

```sh
DRAFT_ID=$(jq -r '.id // .draft.id' /tmp/draft.json)
curl -sS -H "$AUTH" "$BASE_URL/api/v1/drafts/$DRAFT_ID" |
  jq '{id, mailbox, payload: {subject, html, text}}'
```

Expected result: HTTP 201 (or the deployed create status), followed by a GET containing the same synthetic subject and HTML markers `<strong>`, `<a href="https://example.test/draft">`, and `<ul><li>`.

Verify authorization with a different synthetic mailbox:

```sh
curl -sS -o /tmp/foreign-draft.json -w 'HTTP %{http_code}\n' \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -X POST "$BASE_URL/api/v1/drafts" \
  --data-binary @- <<'JSON'
{
  "mailbox": "someone-elses-mailbox@example.test",
  "payload": {
    "to": ["owned-test-mailbox@example.test"],
    "subject": "Synthetic unauthorized draft",
    "html": "<p>must be rejected</p>",
    "text": "must be rejected"
  }
}
JSON
```

Expected output:

```text
HTTP 403
```

## (c) Wide-table sanitization

Fetch a synthetic stored message containing a table through the deployed message-read endpoint:

```sh
curl -sS -H "$AUTH" "$BASE_URL/api/v1/messages/$WIDE_TABLE_MESSAGE_ID" |
  jq -r '.html // .bodyHtml // .body.html // ""' > /tmp/wide-table.html
```

Run the exact shared UI wrapper/sanitizer locally from the deployed source (the function is `wrapEmailHtml` in `packages/web/src/pages/ThreadView.tsx`) and assert the output contains:

```text
overflow-x:auto
min-width
<table
```

The pass condition is that the sanitized output retains the table and wraps it in a horizontally scrollable container with a minimum width, rather than forcing columns into the viewport.

## Evidence policy

Replace identifiers and mailbox values with synthetic fixtures in any pasted output. Paste HTTP status lines, marker checks, and sanitized structural assertions only. Do not paste bearer tokens, message bodies from real users, email addresses, or raw customer records.