/**
 * Cipher interface — PROTOCOL.md §7.
 *
 * Core stays dependency-free: this file defines the contract, and a concrete
 * implementation lives in @tangentfeed/crypto. Other-language implementations are
 * therefore free to use whatever XChaCha20-Poly1305 binding they like, as
 * long as they match the spec'd scheme.
 *
 * What is encrypted: cell VALUES only. table, row, column, hlc, and device
 * stay plaintext in v1 (§7 documents this as a known metadata leak). The
 * tombstone column ("-") is also exempt, because §5 merge rules must be
 * evaluable by any peer — including one that cannot decrypt — to decide
 * whether a row is deleted. A relay therefore learns that a row was deleted,
 * but never what it contained.
 *
 * AAD binds each ciphertext to its op id, so a ciphertext lifted from one op
 * and pasted into another fails authentication rather than silently moving
 * data between cells.
 */

import type { Json } from "./op.js";

export interface Cipher {
  /** Encrypt a cell value. `opId` is bound in as AAD. Returns "e1:<base64>". */
  encrypt(value: Json, opId: string): string;
  /**
   * Decrypt a cell value produced by `encrypt`. Values that are not in the
   * "e1:" envelope MUST be returned unchanged (a space may contain plaintext
   * ops written before encryption was enabled).
   */
  decrypt(value: Json, opId: string): Json;
}

/** Prefix marking an encrypted value envelope. §3.2 */
export const CIPHER_PREFIX = "e1:";

export function isEncryptedValue(v: Json): v is string {
  return typeof v === "string" && v.startsWith(CIPHER_PREFIX);
}

export class DecryptError extends Error {
  readonly code = "DECRYPT_FAIL";
  constructor(msg: string) {
    super(`DECRYPT_FAIL: ${msg}`);
  }
}
