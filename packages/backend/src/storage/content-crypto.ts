import { isEncryptedText, userScope } from "@theaiinc/missive-core";
import { dataCipher } from "../data-cipher";
import { requireUser } from "../request-context";

/**
 * Mail content columns, stored encrypted for the row's owner (see
 * core/src/crypto.ts). Each value is bound to its column ("table.column").
 *
 * Queries decrypt whole rows right after SELECT (openRows), so the row
 * mappers and business logic keep working on plain values. Rows written before
 * encryption pass through unchanged until the startup backfill rewrites them.
 *
 * JSON columns (recipients, digests.items) hold the encrypted JSON text as a
 * JSON string; after opening they are that JSON text again, which the mappers
 * already parse.
 */
export const ENCRYPTED_COLUMNS = {
  missives: ["subject", "body", "body_html", "sender_name", "sender_address", "recipients", "account_email", "summary"],
  threads: ["subject"],
  digests: ["summary", "items"],
} as const;

export type EncryptedTable = keyof typeof ENCRYPTED_COLUMNS;

/** Encrypts one value for the current user (the owner of the row being written). */
export async function seal(table: EncryptedTable, column: string, value: string | null | undefined): Promise<string | null> {
  if (value == null) return null;
  return dataCipher().encrypt(userScope(requireUser().id), `${table}.${column}`, value);
}

/** Same as seal, for a JSON column: encrypts the JSON text, returns it as a JSON string literal. */
export async function sealJson(table: EncryptedTable, column: string, value: unknown): Promise<string> {
  return JSON.stringify(await seal(table, column, JSON.stringify(value ?? null)));
}

/** Decrypts the content columns of a row in place of their ciphertext. */
export async function openRow<T extends Record<string, any>>(table: EncryptedTable, row: T): Promise<T> {
  const out: Record<string, any> = { ...row };
  for (const column of ENCRYPTED_COLUMNS[table]) {
    const value = out[column];
    if (!isEncryptedText(value)) continue;
    if (!row.owner_id) throw new Error(`${table}.${column} is encrypted but the row has no owner`);
    out[column] = await dataCipher().decrypt(userScope(row.owner_id), `${table}.${column}`, value);
  }
  return out as T;
}

export function openRows<T extends Record<string, any>>(table: EncryptedTable, rows: T[]): Promise<T[]> {
  return Promise.all(rows.map((row) => openRow(table, row)));
}
