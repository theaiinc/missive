import { isEncryptedText, userScope } from "@theaiinc/missive-core";
import { dataCipher } from "./data-cipher";
import { isEmptyDraftPayload } from "./draft-content";

/**
 * Compose drafts at rest, encrypted like the rest of the mail (see
 * core/src/crypto.ts and storage/content-crypto.ts): AES-256-GCM under the
 * owner's key (HKDF of MISSIVE_DATA_KEY, scope "user:<owner id>"), so another
 * user's key can't open a draft.
 *
 * Unlike the mail columns, whose associated data is only "table.column", a
 * draft's is "drafts.<column>:<draft id>": a payload copied onto another
 * draft (or another user's row) fails to decrypt.
 *
 * Encrypted: payload (recipients, subject, message, attachment names,
 * thread) and mailbox (the address it's from). In the clear: id, owner_id,
 * timestamps, and is_empty (whether isEmptyDraftPayload holds, so the cleanup
 * can find empty drafts without the key).
 *
 * payload is JSONB; encrypted, it holds the "mv1.…" text as a JSON string, as
 * missives.recipients does. Rows from before this are a JSON object with a
 * plain mailbox, and still read until scripts/encrypt-drafts.ts rewrites them.
 */

export type DraftColumns = { mailbox: string; payload: Record<string, unknown> };

export const draftAad = (column: "payload" | "mailbox", draftId: string) => `drafts.${column}:${draftId}`;

/** A draft that can't be opened: tampered, moved to another row, or another user's. Carries no content. */
export class DraftUnreadableError extends Error {
  constructor(readonly draftId: string) {
    super(`Draft ${draftId} could not be decrypted`);
    this.name = "DraftUnreadableError";
  }
}

/** The values to store for a draft: mailbox and payload (as JSON text for $n::jsonb) encrypted, and is_empty. */
export async function sealDraft(ownerId: string, draftId: string, draft: DraftColumns): Promise<{ mailbox: string; payload: string; isEmpty: boolean }> {
  const scope = userScope(ownerId);
  const payload = await dataCipher().encrypt(scope, draftAad("payload", draftId), JSON.stringify(draft.payload));
  return {
    mailbox: await dataCipher().encrypt(scope, draftAad("mailbox", draftId), draft.mailbox),
    payload: JSON.stringify(payload),
    isEmpty: isEmptyDraftPayload(draft.payload),
  };
}

/**
 * Opens a stored draft row ({ id, owner_id, mailbox, payload }). Plain rows
 * from before encryption pass through. Anything that doesn't decrypt throws
 * DraftUnreadableError; nothing of the row is returned.
 */
export async function openDraft(row: { id: string; owner_id: string; mailbox: unknown; payload: unknown }): Promise<DraftColumns> {
  const scope = userScope(row.owner_id);
  try {
    let mailbox = row.mailbox;
    if (isEncryptedText(mailbox)) mailbox = await dataCipher().decrypt(scope, draftAad("mailbox", row.id), mailbox);
    let payload = row.payload;
    if (typeof payload === "string") {
      // A JSON string is only ever the encrypted payload.
      if (!isEncryptedText(payload)) throw new Error("not encrypted");
      payload = JSON.parse(await dataCipher().decrypt(scope, draftAad("payload", row.id), payload));
    }
    if (typeof mailbox !== "string" || !payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("bad shape");
    return { mailbox, payload: payload as Record<string, unknown> };
  } catch {
    // The cause (an AES-GCM tag failure, or a parse error) is dropped: a JSON
    // parse error can quote the text it was given.
    throw new DraftUnreadableError(row.id);
  }
}

/** Whether a stored row still has a column in the clear (for the backfill). */
export function draftNeedsEncryption(row: { mailbox: unknown; payload: unknown }): boolean {
  return !isEncryptedText(row.mailbox) || typeof row.payload !== "string";
}
