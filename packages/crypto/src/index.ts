/**
 * SpaceCipher — PROTOCOL.md §7 reference implementation.
 *
 * Scheme:
 *   key    = HKDF-SHA256(ikm = space secret, salt = "", info = "tangentfeed/v1/cells", len = 32)
 *   nonce  = 24 random bytes, fresh per encryption
 *   AAD    = op id (UTF-8)
 *   value  = "e1:" + base64( nonce || XChaCha20-Poly1305(plaintext) )
 *   plaintext = canonical JSON of the cell value (§8.1)
 *
 * Why AAD = op id: a ciphertext lifted from one op and pasted into another
 * fails authentication instead of silently relocating data between cells.
 * Why random nonces: 192-bit nonces make collisions negligible without any
 * counter state, which matters for a system where devices write offline and
 * can be restored from backups.
 *
 * Passphrase support uses scrypt (interactive parameters) so a human-memorable
 * secret is not directly usable as key material.
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import {
  CIPHER_PREFIX,
  DecryptError,
  isEncryptedValue,
  type Cipher,
  type Json,
} from "@tangentfeed/core";

const CELL_INFO = "tangentfeed/v1/cells";
const NONCE_BYTES = 24;
const KEY_BYTES = 32;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export class SpaceCipher implements Cipher {
  private readonly key: Uint8Array;

  /** Construct from raw 32-byte key material (the "space secret"). */
  constructor(secret: Uint8Array) {
    if (secret.length < 16) {
      throw new Error("space secret must be at least 16 bytes; use fromPassphrase for text");
    }
    this.key = hkdf(sha256, secret, new Uint8Array(0), utf8.encode(CELL_INFO), KEY_BYTES);
  }

  /**
   * Derive a cipher from a human passphrase. The salt must be identical on
   * every device in the space; the space id is a good, non-secret choice.
   */
  static async fromPassphrase(passphrase: string, salt: string): Promise<SpaceCipher> {
    const secret = await scryptAsync(utf8.encode(passphrase), utf8.encode(salt));
    return new SpaceCipher(secret);
  }

  /** Generate a fresh random space secret (to be shared out of band, e.g. by QR). */
  static generateSecret(): Uint8Array {
    const b = new Uint8Array(KEY_BYTES);
    globalThis.crypto.getRandomValues(b);
    return b;
  }

  encrypt(value: Json, opId: string): string {
    const nonce = new Uint8Array(NONCE_BYTES);
    globalThis.crypto.getRandomValues(nonce);
    const plaintext = utf8.encode(canonicalJson(value));
    const ct = xchacha20poly1305(this.key, nonce, utf8.encode(opId)).encrypt(plaintext);
    const packed = new Uint8Array(nonce.length + ct.length);
    packed.set(nonce, 0);
    packed.set(ct, nonce.length);
    return CIPHER_PREFIX + base64Encode(packed);
  }

  decrypt(value: Json, opId: string): Json {
    if (!isEncryptedValue(value)) return value; // plaintext op, pass through
    let packed: Uint8Array;
    try {
      packed = base64Decode(value.slice(CIPHER_PREFIX.length));
    } catch {
      throw new DecryptError("value is not valid base64");
    }
    if (packed.length <= NONCE_BYTES) throw new DecryptError("ciphertext too short");
    const nonce = packed.subarray(0, NONCE_BYTES);
    const ct = packed.subarray(NONCE_BYTES);
    let pt: Uint8Array;
    try {
      pt = xchacha20poly1305(this.key, nonce, utf8.encode(opId)).decrypt(ct);
    } catch {
      // wrong key, tampered ciphertext, or a ciphertext moved between ops
      throw new DecryptError("authentication failed (wrong key or tampered data)");
    }
    try {
      return JSON.parse(fromUtf8.decode(pt)) as Json;
    } catch {
      throw new DecryptError("decrypted payload is not valid JSON");
    }
  }
}

/** Canonical JSON per §8.1: sorted object keys, no whitespace. */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k] as Json)).join(",") +
    "}"
  );
}

async function scryptAsync(pw: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  // interactive parameters: ~100ms on a laptop, tolerable on phones
  return scrypt(pw, salt, { N: 2 ** 15, r: 8, p: 1, dkLen: KEY_BYTES });
}

function base64Encode(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  return Buffer.from(bytes).toString("base64");
}

function base64Decode(s: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}
