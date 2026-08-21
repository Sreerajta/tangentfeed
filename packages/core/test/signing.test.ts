import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  SIGNING_DOMAIN,
  deviceIdFromPublicKey,
  generateDeviceKey,
  signPayload,
  verifyPayload,
} from "../src/index.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("device keys", () => {
  it("generates 32-byte keypairs", () => {
    const key = generateDeviceKey();
    expect(key.publicKey.length).toBe(32);
    expect(key.privateKey.length).toBe(32);
  });

  it("derives a 32-character lowercase hex deviceId", () => {
    expect(deviceIdFromPublicKey(generateDeviceKey().publicKey)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("derives the same id from the same key, every time", () => {
    const key = generateDeviceKey();
    expect(deviceIdFromPublicKey(key.publicKey)).toBe(deviceIdFromPublicKey(key.publicKey));
  });

  it("derives different ids from different keys", () => {
    const a = deviceIdFromPublicKey(generateDeviceKey().publicKey);
    const b = deviceIdFromPublicKey(generateDeviceKey().publicKey);
    expect(a).not.toBe(b);
  });

  it("uses the first 16 bytes of SHA-256, not the whole digest", () => {
    const key = generateDeviceKey();
    const expected = [...sha256(key.publicKey).slice(0, 16)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(deviceIdFromPublicKey(key.publicKey)).toBe(expected);
  });
});

describe("signing", () => {
  it("round-trips", () => {
    const key = generateDeviceKey();
    const payload = utf8("hello");
    expect(verifyPayload(payload, signPayload(payload, key.privateKey), key.publicKey)).toBe(true);
  });

  it("produces base64 of a 64-byte signature", () => {
    const key = generateDeviceKey();
    const sig = signPayload(utf8("hello"), key.privateKey);
    expect(Buffer.from(sig, "base64").length).toBe(64);
  });

  it("rejects a tampered payload", () => {
    const key = generateDeviceKey();
    const sig = signPayload(utf8("hello"), key.privateKey);
    expect(verifyPayload(utf8("hell0"), sig, key.publicKey)).toBe(false);
  });

  it("rejects the wrong public key", () => {
    const signer = generateDeviceKey();
    const other = generateDeviceKey();
    const payload = utf8("hello");
    expect(verifyPayload(payload, signPayload(payload, signer.privateKey), other.publicKey)).toBe(
      false,
    );
  });

  it("rejects malformed base64 without throwing", () => {
    const key = generateDeviceKey();
    expect(verifyPayload(utf8("hello"), "not base64!!", key.publicKey)).toBe(false);
    expect(verifyPayload(utf8("hello"), "", key.publicKey)).toBe(false);
  });

  it("exposes the domain constant", () => {
    expect(SIGNING_DOMAIN).toBe("tangentfeed/v2/op");
  });
});
