/**
 * Canonical JSON conformance vectors (§8.1).
 *
 * These pin RFC 8785 behaviour, which is load-bearing for interoperability:
 * the plaintext under end-to-end encryption is canonical JSON, so an
 * implementation that canonicalizes differently produces ciphertext no other
 * implementation can authenticate.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/index.js";
import type { Json } from "@tangentfeed/core";

const VECTORS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../conformance/canonical",
);

interface Case {
  description: string;
  input: Json;
  expected: string;
}

interface Vector {
  name: string;
  description: string;
  cases: Case[];
}

const vectors: Vector[] = readdirSync(VECTORS_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(VECTORS_DIR, f), "utf8")) as Vector);

describe("canonical JSON vectors", () => {
  it("finds vector files", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const vector of vectors) {
    describe(vector.name, () => {
      for (const c of vector.cases) {
        it(c.description, () => {
          expect(canonicalJson(c.input)).toBe(c.expected);
        });
      }
    });
  }

  it("is idempotent: canonicalizing a parsed canonical form reproduces it", () => {
    for (const vector of vectors) {
      for (const c of vector.cases) {
        expect(canonicalJson(JSON.parse(c.expected) as Json)).toBe(c.expected);
      }
    }
  });
});
