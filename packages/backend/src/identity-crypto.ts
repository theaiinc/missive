import { isEncryptedText } from "@theaiinc/missive-core";
import { dataCipher } from "./data-cipher";

/**
 * Addresses that identify things -- a user's email, a hosted mailbox -- are
 * needed before any user context exists (sign-in, inbound mail), so they use
 * a system key rather than a user key. They are stored encrypted and found by
 * blind index (a keyed hash of the normalised address).
 */
const SCOPE = "system:identity" as const;

export const normalizeAddress = (address: string) => address.trim().toLowerCase();

export function addressIndex(label: "users.email" | "mailboxes.address" | "connectors.email", address: string): Promise<string> {
  return dataCipher().blindIndex(label, normalizeAddress(address));
}

export function sealIdentity(aad: string, value: string | null | undefined): Promise<string | null> {
  return value == null ? Promise.resolve(null) : dataCipher().encrypt(SCOPE, aad, value);
}

/** Opens an identity value; plaintext from before encryption is passed through. */
export async function openIdentity(aad: string, value: string | null | undefined): Promise<string | null> {
  if (value == null) return null;
  return isEncryptedText(value) ? dataCipher().decrypt(SCOPE, aad, value) : value;
}
