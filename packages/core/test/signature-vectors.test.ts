/**
 * Signature conformance vectors (§12).
 *
 * The negative cases carry the weight. A verifier that returns true
 * unconditionally passes every positive case in this file, which is why an
 * implementation is not conforming until the rejections pass too.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SIGNING_DOMAIN,
  canonicalJson,
  deviceIdFromPublicKey,
  signPayload,
  verifyPayload,
  type Json,
} from "../src/index.js";

const FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../conformance/signatures/01-op-signatures.json",
);

interface Case {
  description: string;
  op: Record<string, unknown>;
  expectedSignature?: string;
  reason?: string;
}

interface Vector {
  domain: string;
  testKey: { privateKey: string; publicKey: string; deviceId: string };
  cases: Case[];
  negative: Case[];
}

const vector = JSON.parse(readFileSync(FILE, "utf8")) as Vector;
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
const publicKey = unhex(vector.testKey.publicKey);
const privateKey = unhex(vector.testKey.privateKey);

/** The exact bytes a signature covers: domain, then canonical JSON minus `sig`. */
function payloadFor(op: Record<string, unknown>): Uint8Array {
  const { sig: _drop, ...rest } = op;
  return new TextEncoder().encode(SIGNING_DOMAIN + canonicalJson(rest as Json));
}

describe("signature vectors", () => {
  it("uses the domain this implementation uses", () => {
    expect(vector.domain).toBe(SIGNING_DOMAIN);
  });

  it("derives the vector's deviceId from the vector's public key", () => {
    expect(deviceIdFromPublicKey(publicKey)).toBe(vector.testKey.deviceId);
  });

  it("every op in the vector names that deviceId", () => {
    for (const c of vector.cases) {
      expect(c.op["device"]).toBe(vector.testKey.deviceId);
    }
  });

  for (const c of vector.cases) {
    it(`verifies: ${c.description}`, () => {
      expect(verifyPayload(payloadFor(c.op), c.expectedSignature!, publicKey)).toBe(true);
    });

    it(`reproduces the signature byte for byte: ${c.description}`, () => {
      // Ed25519 is deterministic, so an implementation that agrees on the
      // payload produces exactly this string. This is what makes the vectors
      // a contract rather than a smoke test.
      expect(signPayload(payloadFor(c.op), privateKey)).toBe(c.expectedSignature);
    });
  }

  for (const c of vector.negative) {
    it(`rejects: ${c.description}`, () => {
      const sig = c.op["sig"] as string;
      expect(verifyPayload(payloadFor(c.op), sig, publicKey)).toBe(false);
    });
  }

  it("has more negative cases than a single happy path", () => {
    expect(vector.negative.length).toBeGreaterThanOrEqual(vector.cases.length - 1);
  });
});
