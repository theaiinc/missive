import { DataCipher, isEncryptedText, userScope } from "@theaiinc/missive-core";
import { requireUser } from "./request-context";

/**
 * The one DataCipher for this process (MISSIVE_DATA_KEY; see core/src/crypto.ts).
 * Throws when the key is missing: email data is never written in the clear
 * as a fallback.
 */
let instance: DataCipher | undefined;
export function dataCipher(): DataCipher {
  instance ??= DataCipher.fromSecret(process.env.MISSIVE_DATA_KEY);
  return instance;
}

/** Encrypts `plain` for the signed-in user (or the user a background job runs as). */
export function sealForCurrentUser(aad: string, plain: string): Promise<string> {
  return dataCipher().encrypt(userScope(requireUser().id), aad, plain);
}

/** Opens a value sealed for `ownerId`. Plaintext from before encryption is passed through. */
export async function openForOwner(ownerId: string, aad: string, value: string): Promise<string> {
  if (!isEncryptedText(value)) return value;
  return dataCipher().decrypt(userScope(ownerId), aad, value);
}
