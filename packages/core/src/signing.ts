/**
 * Canonical JSON and operation signing — PROTOCOL.md §8.1 and §12.
 *
 * These live in core rather than crypto because core needs them to validate an
 * op, and crypto already depends on core. Putting them the other way round
 * would make the graph cyclic. Crypto re-exports both, so its public API is
 * unchanged.
 *
 * Everything here is bytes in, bytes out — it knows nothing about operations,
 * which is what lets it be tested without an engine.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

import type { Json } from "./op.js";

/**
 * Prefixed to every signed payload so a signature can never be replayed as
 * valid in some other context.
 */
export const SIGNING_DOMAIN = "tangentfeed/v2/op";

export interface DeviceKey {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/** Canonical JSON per RFC 8785. §8.1. */
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

export function generateDeviceKey(): DeviceKey {
  const { secretKey, publicKey } = ed25519.keygen();
  return { publicKey, privateKey: secretKey };
}

/**
 * deviceId is the first 16 bytes of SHA-256(publicKey), lowercase hex.
 *
 * 128 bits rather than v0.1's 64: this identifier became a security boundary
 * when it started deciding whose signature counts, and a targeted
 * impersonation at 64 bits is within reach of a determined adversary.
 */
export function deviceIdFromPublicKey(publicKey: Uint8Array): string {
  const digest = sha256(publicKey);
  let out = "";
  for (let i = 0; i < 16; i++) out += digest[i]!.toString(16).padStart(2, "0");
  return out;
}

export function signPayload(payload: Uint8Array, privateKey: Uint8Array): string {
  return base64Encode(ed25519.sign(payload, privateKey));
}

/**
 * Returns false rather than throwing on malformed input. A bad signature from
 * a peer is a routine condition on an open network, not an exceptional one.
 */
export function verifyPayload(
  payload: Uint8Array,
  signature: string,
  publicKey: Uint8Array,
): boolean {
  try {
    const sig = base64Decode(signature);
    if (sig.length !== 64) return false;
    return ed25519.verify(sig, payload, publicKey);
  } catch {
    return false;
  }
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
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("not base64");
  if (typeof atob === "function") {
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}
