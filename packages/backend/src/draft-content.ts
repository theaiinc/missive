/**
 * When a saved compose draft holds nothing: no recipients, subject, body or
 * attachment. The web app never saves one like that (Compose.tsx), the API
 * refuses to create one, and scripts/cleanup-empty-drafts.ts removes the ones
 * saved before both of those were true. The body is the editor's HTML; the
 * signature and a reply's quote aren't something the person wrote.
 */
export function isEmptyDraftPayload(payload: Record<string, unknown>): boolean {
  const blank = (value: unknown) => typeof value !== "string" || value.trim() === "";
  const bodyText = typeof payload.html === "string" ? payload.html.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "") : "";
  const attachments = Array.isArray(payload.attachments) ? payload.attachments.length : 0;
  return blank(payload.to) && blank(payload.cc) && blank(payload.bcc) && blank(payload.subject) && bodyText === "" && attachments === 0;
}

/** isEmptyDraftPayload as SQL over a plain (JSON object) drafts.payload. */
export const PLAIN_EMPTY_DRAFT_SQL = `
      COALESCE(btrim(payload->>'to'), '') = ''
  AND COALESCE(btrim(payload->>'cc'), '') = ''
  AND COALESCE(btrim(payload->>'bcc'), '') = ''
  AND COALESCE(btrim(payload->>'subject'), '') = ''
  AND COALESCE(regexp_replace(regexp_replace(payload->>'html', '<[^>]*>', '', 'g'), '&nbsp;|\\s', '', 'g'), '') = ''
  AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(payload->'attachments') = 'array' THEN payload->'attachments' END), 0) = 0`;

/**
 * Which drafts are empty, for the cleanup. Drafts are stored encrypted
 * (draft-crypto.ts) with is_empty set from isEmptyDraftPayload when saved.
 * Rows from before that (is_empty NULL, payload still a JSON object) are
 * judged from their plain payload. An encrypted payload is never judged by
 * the plain SQL: its fields would all read as missing, i.e. empty.
 */
export const EMPTY_DRAFT_SQL = `(
      is_empty IS TRUE
   OR (is_empty IS NULL AND jsonb_typeof(payload) = 'object' AND ${PLAIN_EMPTY_DRAFT_SQL}
      )
)`;
