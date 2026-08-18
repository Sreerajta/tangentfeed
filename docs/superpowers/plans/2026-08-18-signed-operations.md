# Signed Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every operation carries an Ed25519 signature, and `deviceId` is derived from the public key, so an op cannot be forged and an identity cannot be claimed without the key that proves it.

**Architecture:** Signing lives in `@tangentfeed/crypto` beside the existing cipher. `@tangentfeed/core` gains a `sig` field, a wider `deviceId`, and signature verification ahead of the drift check. Keys persist through two new `StorageAdapter` methods and travel between peers in the sync session. Merge semantics are untouched: signing is a gate in front of §5, not a change to it.

**Tech Stack:** TypeScript (ESM), `@noble/curves` for Ed25519, `@noble/hashes` for SHA-256 (already a dependency), vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-signed-operations-design.md`

**Scope:** protocol, conformance vectors, and the TypeScript implementation. The Dart implementation is a follow-on plan; between the two it will fail against the regenerated vectors, which is expected and should not be worked around.

## Global Constraints

- **`deviceId` is 32 lowercase hex characters** — the first 16 bytes of `SHA-256(publicKey)`, 128 bits.
- **HLC strings are 50 characters**: `{millis:12}-{counter:4}-{deviceId:32}`. Every field stays fixed-width, zero-padded, lowercase hex, so bytewise comparison still equals logical comparison.
- **Signed message** is `"tangentfeed/v2/op"` followed by the canonical JSON (§8.1) of `{id, table, row, column, value, hlc, device}` — the op **without** `sig`.
- **Encrypt-then-sign.** `value` is already the `e1:` envelope when signed. Never sign plaintext.
- **Unsigned ops are invalid in every space.** No per-space policy, no tolerance mode.
- **Wire version is `2`.** A v1 and a v2 peer abort at `hello`.
- **Validation order:** shape → signature → drift → merge.
- **Merge semantics do not change.** §5 behaviour must be identical before and after.
- ESM with explicit `.js` extensions on relative imports, matching every other package.

---

### Task 1: Signing primitives

**Files:**
- Create: `packages/crypto/src/signing.ts`
- Modify: `packages/crypto/src/index.ts`
- Modify: `packages/crypto/package.json`
- Test: `packages/crypto/test/signing.test.ts`

**Interfaces:**
- Produces:
  - `interface DeviceKey { publicKey: Uint8Array; privateKey: Uint8Array }`
  - `generateDeviceKey(): DeviceKey`
  - `deviceIdFromPublicKey(publicKey: Uint8Array): string` — 32 lowercase hex
  - `signPayload(payload: Uint8Array, privateKey: Uint8Array): string` — base64
  - `verifyPayload(payload: Uint8Array, signature: string, publicKey: Uint8Array): boolean`
  - `SIGNING_DOMAIN = "tangentfeed/v2/op"`

This task deliberately knows nothing about ops. It handles bytes, so it can be tested without the engine, and Task 3 composes it with canonical JSON.

- [ ] **Step 1: Add the dependency**

```bash
npm install @noble/curves@^2.3.0 -w @tangentfeed/crypto
```

- [ ] **Step 2: Write the failing test**

`packages/crypto/test/signing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
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
    const id = deviceIdFromPublicKey(generateDeviceKey().publicKey);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
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

  it("uses the first 16 bytes of SHA-256, not the whole digest", async () => {
    const { sha256 } = await import("@noble/hashes/sha2.js");
    const key = generateDeviceKey();
    const digest = sha256(key.publicKey);
    const expected = [...digest.slice(0, 16)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(deviceIdFromPublicKey(key.publicKey)).toBe(expected);
  });
});

describe("signing", () => {
  const domain = utf8(SIGNING_DOMAIN);

  it("round-trips", () => {
    const key = generateDeviceKey();
    const payload = utf8("hello");
    const sig = signPayload(payload, key.privateKey);
    expect(verifyPayload(payload, sig, key.publicKey)).toBe(true);
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
    const sig = signPayload(payload, signer.privateKey);
    expect(verifyPayload(payload, sig, other.publicKey)).toBe(false);
  });

  it("rejects malformed base64 without throwing", () => {
    const key = generateDeviceKey();
    expect(verifyPayload(utf8("hello"), "not base64!!", key.publicKey)).toBe(false);
    expect(verifyPayload(utf8("hello"), "", key.publicKey)).toBe(false);
  });

  it("exposes the domain constant", () => {
    expect(SIGNING_DOMAIN).toBe("tangentfeed/v2/op");
    expect(domain.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w @tangentfeed/crypto -- signing`
Expected: FAIL — `generateDeviceKey` is not exported.

- [ ] **Step 4: Implement**

`packages/crypto/src/signing.ts`:

```ts
/**
 * Operation signing — PROTOCOL.md section 12.
 *
 * Bytes in, bytes out. This module knows nothing about operations, so it can
 * be tested on its own; composing it with canonical JSON is the engine's job.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * Prefixed to every signed payload so a signature can never be valid in
 * another context.
 */
export const SIGNING_DOMAIN = "tangentfeed/v2/op";

export interface DeviceKey {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

export function generateDeviceKey(): DeviceKey {
  const { secretKey, publicKey } = ed25519.keygen();
  return { publicKey, privateKey: secretKey };
}

/**
 * deviceId is the first 16 bytes of SHA-256(publicKey), lowercase hex.
 *
 * 128 bits rather than the 64 of v0.1: this identifier is a security boundary
 * now, and a targeted impersonation at 64 bits is within reach.
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
 * Returns false rather than throwing on malformed input: a bad signature from
 * a peer is a routine condition, not an exceptional one.
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
```

- [ ] **Step 5: Export it**

Add to `packages/crypto/src/index.ts`:

```ts
export {
  SIGNING_DOMAIN,
  deviceIdFromPublicKey,
  generateDeviceKey,
  signPayload,
  verifyPayload,
  type DeviceKey,
} from "./signing.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w @tangentfeed/crypto`
Expected: PASS, existing cipher tests plus 12 new ones.

- [ ] **Step 7: Commit**

```bash
git add packages/crypto package-lock.json
git commit -m "feat(crypto): Ed25519 signing primitives and deviceId derivation"
```

---

### Task 2: Signature conformance vectors

The cross-implementation contract. Without this, Dart could implement a self-consistent scheme that never interoperates.

**Files:**
- Create: `conformance/signatures/01-op-signatures.json`
- Create: `conformance/signatures/generate.mjs`
- Test: `packages/crypto/test/signature-vectors.test.ts`
- Modify: `conformance/README.md`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: a vector file whose shape is
  `{ name, description, testKey: { privateKey, publicKey, deviceId }, cases: [{ description, op, expectedSignature }], negative: [{ description, op, publicKey, reason }] }`
  with all key material hex-encoded.

- [ ] **Step 1: Write the generator**

`conformance/signatures/generate.mjs`:

```js
/**
 * Regenerates the signature vectors.
 *
 *   node conformance/signatures/generate.mjs > conformance/signatures/01-op-signatures.json
 *
 * The private key is fixed and committed on purpose: these vectors have to be
 * reproducible byte for byte in every implementation, which a random key
 * cannot be. It protects nothing and must never be used for real data.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

// Deterministic, not random: the vectors must be regenerable anywhere.
const privateKey = unhex("0001020304050607080910111213141516171819202122232425262728293031");
const publicKey = ed25519.getPublicKey(privateKey);
const deviceId = hex(sha256(publicKey).slice(0, 16));

const DOMAIN = "tangentfeed/v2/op";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

function sign(op) {
  const { sig: _drop, ...rest } = op;
  const payload = new TextEncoder().encode(DOMAIN + canonicalJson(rest));
  return Buffer.from(ed25519.sign(payload, privateKey)).toString("base64");
}

const hlc = (millis, counter) =>
  `${millis.toString(16).padStart(12, "0")}-${counter.toString(16).padStart(4, "0")}-${deviceId}`;

const mkOp = (over = {}) => {
  const h = over.hlc ?? hlc(0x018bcfe56800, 0);
  return {
    id: h,
    table: "tasks",
    row: "01HZX3NDEKTSV4RRFFQ69G5FAA",
    column: "title",
    value: "buy milk",
    hlc: h,
    device: deviceId,
    ...over,
  };
};

const cases = [
  { description: "a string value", op: mkOp() },
  { description: "a boolean value", op: mkOp({ column: "done", value: false }) },
  { description: "a null value, which clears the cell", op: mkOp({ column: "note", value: null }) },
  { description: "a nested object value", op: mkOp({ column: "place", value: { lat: 1, lon: 2 } }) },
  { description: "an array value", op: mkOp({ column: "tags", value: ["a", "b"] }) },
  { description: "a row tombstone", op: mkOp({ column: "-", value: true }) },
  {
    description: "an encrypted value, signed over the ciphertext (encrypt-then-sign)",
    op: mkOp({ value: "e1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
  },
].map((c) => ({ ...c, expectedSignature: sign(c.op) }));

const valid = cases[0];

const negative = [
  {
    description: "the value was changed after signing",
    op: { ...valid.op, value: "buy oat milk", sig: valid.expectedSignature },
    reason: "TAMPERED_VALUE",
  },
  {
    description: "the table was changed after signing",
    op: { ...valid.op, table: "notes", sig: valid.expectedSignature },
    reason: "TAMPERED_TABLE",
  },
  {
    description: "a signature lifted from a different op",
    op: { ...cases[1].op, sig: valid.expectedSignature },
    reason: "SIGNATURE_FROM_ANOTHER_OP",
  },
  {
    description: "the signature is absent",
    op: { ...valid.op },
    reason: "MISSING_SIGNATURE",
  },
  {
    description: "the signature is not valid base64",
    op: { ...valid.op, sig: "!!!not base64!!!" },
    reason: "MALFORMED_SIGNATURE",
  },
  {
    description: "a well-formed signature of the right length that is simply wrong",
    op: { ...valid.op, sig: Buffer.alloc(64).toString("base64") },
    reason: "BAD_SIGNATURE",
  },
];

console.log(
  JSON.stringify(
    {
      name: "op-signatures",
      description:
        "Ed25519 signatures over the canonical JSON of an op, domain-separated " +
        "with \"tangentfeed/v2/op\". The private key is fixed so the vectors are " +
        "reproducible; it protects nothing. Negative cases matter more than " +
        "positive ones: a verifier that accepts everything passes every positive test.",
      domain: DOMAIN,
      testKey: { privateKey: hex(privateKey), publicKey: hex(publicKey), deviceId },
      cases,
      negative,
    },
    null,
    2,
  ),
);
```

- [ ] **Step 2: Generate the vectors**

```bash
node conformance/signatures/generate.mjs > conformance/signatures/01-op-signatures.json
```

Confirm it parses and the deviceId is 32 hex characters:

```bash
node -e "const v=require('./conformance/signatures/01-op-signatures.json'); console.log(v.testKey.deviceId.length, v.cases.length, v.negative.length)"
```

Expected: `32 7 6`

- [ ] **Step 3: Write the harness**

`packages/crypto/test/signature-vectors.test.ts`:

```ts
/**
 * Signature conformance vectors.
 *
 * The negative cases carry the weight. A verifier that returns true
 * unconditionally passes every positive case in this file.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/index.js";
import { SIGNING_DOMAIN, deviceIdFromPublicKey, verifyPayload } from "../src/index.js";

const FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../conformance/signatures/01-op-signatures.json",
);

interface Vector {
  domain: string;
  testKey: { privateKey: string; publicKey: string; deviceId: string };
  cases: { description: string; op: Record<string, unknown>; expectedSignature: string }[];
  negative: { description: string; op: Record<string, unknown>; reason: string }[];
}

const vector = JSON.parse(readFileSync(FILE, "utf8")) as Vector;
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
const publicKey = unhex(vector.testKey.publicKey);

const payloadFor = (op: Record<string, unknown>) => {
  const { sig: _drop, ...rest } = op;
  return new TextEncoder().encode(SIGNING_DOMAIN + canonicalJson(rest as never));
};

describe("signature vectors", () => {
  it("uses the domain this implementation uses", () => {
    expect(vector.domain).toBe(SIGNING_DOMAIN);
  });

  it("derives the vector's deviceId from the vector's public key", () => {
    expect(deviceIdFromPublicKey(publicKey)).toBe(vector.testKey.deviceId);
  });

  for (const c of vector.cases) {
    it(`verifies: ${c.description}`, () => {
      expect(verifyPayload(payloadFor(c.op), c.expectedSignature, publicKey)).toBe(true);
    });
  }

  for (const c of vector.negative) {
    it(`rejects: ${c.description}`, () => {
      const sig = (c.op as { sig?: string }).sig;
      if (sig === undefined) return; // absence is Task 3's shape check, not a crypto failure
      expect(verifyPayload(payloadFor(c.op), sig, publicKey)).toBe(false);
    });
  }
});
```

- [ ] **Step 4: Run it**

Run: `npm test -w @tangentfeed/crypto -- signature-vectors`
Expected: PASS.

- [ ] **Step 5: Document the new directory**

In `conformance/README.md`, add to the Layout table:

```
| `signatures/` | Ed25519 op signatures, domain separation, and the tampering cases that must be rejected | §12 |
```

- [ ] **Step 6: Commit**

```bash
git add conformance/signatures conformance/README.md packages/crypto/test/signature-vectors.test.ts
git commit -m "test(conformance): signature vectors, positive and negative"
```

---

### Task 3: Core — the `sig` field and the wider deviceId

**Files:**
- Modify: `packages/core/src/hlc.ts`
- Modify: `packages/core/src/op.ts`
- Modify: `packages/core/package.json`
- Test: `packages/core/test/signed-op.test.ts`

**Interfaces:**
- Consumes: `SIGNING_DOMAIN`, `verifyPayload`, `deviceIdFromPublicKey` from `@tangentfeed/crypto`.
- Produces:
  - `Op` gains `readonly sig: string`
  - `signedPayload(op: Omit<Op, "sig">): Uint8Array`
  - `verifyOp(op: Op, publicKey: Uint8Array): boolean`
  - `DEVICE_ID_HEX = 32`, `HLC_LENGTH = 50`

`@tangentfeed/core` currently has zero dependencies and this adds one on `@tangentfeed/crypto`. That inverts the existing direction — crypto depends on core today. To avoid a cycle, the *primitives* move: `canonicalJson` and the signing functions are what core needs, and they have no core dependency of their own.

- [ ] **Step 1: Move the primitives so the dependency points one way**

Move `canonicalJson` from `packages/crypto/src/index.ts` and the whole of `packages/crypto/src/signing.ts` into `packages/core/src/signing.ts`, then re-export both from crypto so its public API is unchanged:

`packages/crypto/src/index.ts` gains:

```ts
export {
  SIGNING_DOMAIN,
  canonicalJson,
  deviceIdFromPublicKey,
  generateDeviceKey,
  signPayload,
  verifyPayload,
  type DeviceKey,
} from "@tangentfeed/core";
```

and loses its own definitions of those. Move `@noble/curves` and `@noble/hashes` to `packages/core/package.json` dependencies. Core is no longer zero-dependency; update its README and the root README table, which both claim otherwise.

- [ ] **Step 2: Write the failing test**

`packages/core/test/signed-op.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  DEVICE_ID_HEX,
  HLC_LENGTH,
  BadOpError,
  encodeHlc,
  decodeHlc,
  validateOp,
  signedPayload,
  verifyOp,
  generateDeviceKey,
  deviceIdFromPublicKey,
  signPayload,
  type Op,
} from "../src/index.js";

const key = generateDeviceKey();
const device = deviceIdFromPublicKey(key.publicKey);
const hlc = `018bcfe56800-0000-${device}`;

function signed(over: Partial<Op> = {}): Op {
  const base = {
    id: hlc,
    table: "tasks",
    row: "01HZX3NDEKTSV4RRFFQ69G5FAA",
    column: "title",
    value: "buy milk" as const,
    hlc,
    device,
    ...over,
  };
  return { ...base, sig: signPayload(signedPayload(base), key.privateKey) } as Op;
}

describe("widened deviceId", () => {
  it("is 32 hex characters", () => {
    expect(DEVICE_ID_HEX).toBe(32);
    expect(device).toMatch(/^[0-9a-f]{32}$/);
  });

  it("makes HLC strings 50 characters", () => {
    expect(HLC_LENGTH).toBe(50);
    expect(encodeHlc({ millis: 0x018bcfe56800, counter: 0, deviceId: device })).toHaveLength(50);
  });

  it("still round-trips", () => {
    const h = { millis: 0x018bcfe56800, counter: 3, deviceId: device };
    expect(decodeHlc(encodeHlc(h))).toEqual(h);
  });

  it("still orders bytewise the same as logically", () => {
    const a = encodeHlc({ millis: 1, counter: 0, deviceId: device });
    const b = encodeHlc({ millis: 2, counter: 0, deviceId: device });
    expect(a < b).toBe(true);
  });

  it("rejects a 16-character deviceId, which v0.1 used", () => {
    expect(() => decodeHlc("018bcfe56800-0000-a1b2c3d4e5f60718")).toThrow();
  });
});

describe("op signatures", () => {
  it("accepts a correctly signed op", () => {
    const op = signed();
    expect(() => validateOp(op)).not.toThrow();
    expect(verifyOp(op, key.publicKey)).toBe(true);
  });

  it("rejects an op with no signature", () => {
    const { sig: _drop, ...unsigned } = signed();
    expect(() => validateOp(unsigned)).toThrow(BadOpError);
  });

  it("rejects a tampered value", () => {
    expect(verifyOp({ ...signed(), value: "something else" }, key.publicKey)).toBe(false);
  });

  it("rejects a tampered table", () => {
    expect(verifyOp({ ...signed(), table: "notes" }, key.publicKey)).toBe(false);
  });

  it("rejects a signature made by another key", () => {
    const other = generateDeviceKey();
    expect(verifyOp(signed(), other.publicKey)).toBe(false);
  });

  it("excludes sig from the signed payload, so signing is deterministic", () => {
    const op = signed();
    const withJunk = { ...op, sig: "different" };
    expect(signedPayload(op)).toEqual(signedPayload(withJunk as never));
  });

  it("binds the signature to the hlc, so an op cannot be backdated", () => {
    const op = signed();
    const older = `018bcfe56700-0000-${device}`;
    expect(verifyOp({ ...op, hlc: older, id: older }, key.publicKey)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w @tangentfeed/core -- signed-op`
Expected: FAIL — `DEVICE_ID_HEX` is not exported.

- [ ] **Step 4: Widen the deviceId in `hlc.ts`**

Replace the two patterns and add the constants:

```ts
export const DEVICE_ID_HEX = 32;
export const HLC_LENGTH = 50; // 12 + 1 + 4 + 1 + 32

const DEVICE_ID_RE = /^[0-9a-f]{32}$/;
const HLC_RE = /^([0-9a-f]{12})-([0-9a-f]{4})-([0-9a-f]{32})$/;
```

`isValidDeviceId`, `encodeHlc` and `decodeHlc` otherwise keep their current bodies — only the widths change.

Delete `generateDeviceId`: an identity is now derived from a key, never invented. Every call site is updated in Task 5.

- [ ] **Step 5: Add `sig` to the op in `op.ts`**

Add to the `Op` interface:

```ts
  /** Base64 Ed25519 signature over signedPayload(op). §12. */
  readonly sig: string;
```

Add `"sig"` to the required-string loop in `validateOp`:

```ts
  for (const f of ["id", "table", "row", "column", "hlc", "device", "sig"]) {
```

Then append the two new functions:

```ts
/**
 * The exact bytes a signature covers: the domain, then the canonical JSON of
 * every field except `sig` itself.
 *
 * `sig` is excluded so signing is deterministic — including it would require
 * knowing the signature before computing it.
 */
export function signedPayload(op: Omit<Op, "sig"> | Op): Uint8Array {
  const { id, table, row, column, value, hlc, device } = op;
  const canonical = canonicalJson({ id, table, row, column, value, hlc, device });
  return new TextEncoder().encode(SIGNING_DOMAIN + canonical);
}

/** Whether `op.sig` is a valid signature by `publicKey`. §12. */
export function verifyOp(op: Op, publicKey: Uint8Array): boolean {
  return verifyPayload(signedPayload(op), op.sig, publicKey);
}
```

- [ ] **Step 6: Run the tests**

Run: `npm test -w @tangentfeed/core -- signed-op`
Expected: PASS, 12 tests. Other core suites will fail — their fixtures use 16-character deviceIds. Task 7 regenerates them.

- [ ] **Step 7: Commit**

```bash
git add packages/core packages/crypto
git commit -m "feat(core): sig field, 128-bit deviceId, signature verification"
```

---

### Task 4: Storage — persist the keypair

**Files:**
- Modify: `packages/core/src/storage.ts`
- Modify: `packages/adapter-idb/src/index.ts`
- Modify: `packages/adapter-sqlite/src/index.ts`
- Test: `packages/core/test/device-key-storage.test.ts`

**Interfaces:**
- Produces, on `StorageAdapter`:
  - `getDeviceKey(): Promise<DeviceKey | undefined>`
  - `setDeviceKey(key: DeviceKey): Promise<void>`

- [ ] **Step 1: Write the failing test**

`packages/core/test/device-key-storage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MemoryAdapter, generateDeviceKey } from "../src/index.js";

describe("device key persistence", () => {
  it("returns undefined before anything is stored", async () => {
    expect(await new MemoryAdapter().getDeviceKey()).toBeUndefined();
  });

  it("round-trips a keypair", async () => {
    const storage = new MemoryAdapter();
    const key = generateDeviceKey();
    await storage.setDeviceKey(key);

    const read = await storage.getDeviceKey();
    expect(read).toBeDefined();
    expect([...read!.publicKey]).toEqual([...key.publicKey]);
    expect([...read!.privateKey]).toEqual([...key.privateKey]);
  });

  it("overwrites rather than accumulating", async () => {
    const storage = new MemoryAdapter();
    await storage.setDeviceKey(generateDeviceKey());
    const second = generateDeviceKey();
    await storage.setDeviceKey(second);
    expect([...(await storage.getDeviceKey())!.publicKey]).toEqual([...second.publicKey]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @tangentfeed/core -- device-key-storage`
Expected: FAIL — `getDeviceKey` is not a function.

- [ ] **Step 3: Extend the interface and MemoryAdapter**

In `packages/core/src/storage.ts`, add to `StorageAdapter`:

```ts
  /**
   * The device's signing keypair, or undefined on a fresh store.
   *
   * Stored in the clear alongside the data it protects. On a device this
   * belongs in Keychain or Keystore; recorded as follow-up work rather than
   * solved here, because the space secret already has the same exposure.
   */
  getDeviceKey(): Promise<DeviceKey | undefined>;
  setDeviceKey(key: DeviceKey): Promise<void>;
```

and to `MemoryAdapter`:

```ts
  private deviceKey: DeviceKey | undefined;

  async getDeviceKey(): Promise<DeviceKey | undefined> {
    return this.deviceKey;
  }

  async setDeviceKey(key: DeviceKey): Promise<void> {
    this.deviceKey = key;
  }
```

- [ ] **Step 4: Implement in the IndexedDB adapter**

Store both halves hex-encoded in the existing meta store, so no schema version bump is needed:

```ts
  async getDeviceKey(): Promise<DeviceKey | undefined> {
    const raw = await this.readMeta("deviceKey");
    if (typeof raw !== "string") return undefined;
    const [pub, priv] = raw.split(":");
    if (!pub || !priv) return undefined;
    return { publicKey: unhex(pub), privateKey: unhex(priv) };
  }

  async setDeviceKey(key: DeviceKey): Promise<void> {
    await this.writeMeta("deviceKey", `${hex(key.publicKey)}:${hex(key.privateKey)}`);
  }
```

with these helpers at module scope:

```ts
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
```

If `readMeta`/`writeMeta` are not the existing names in this adapter, use whatever it already uses for the clock and frontier — the point is to reuse the meta store rather than add one.

- [ ] **Step 5: Implement in the SQLite adapter**

Same encoding, into the existing `meta` table:

```ts
  async getDeviceKey(): Promise<DeviceKey | undefined> {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'deviceKey'").get() as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    const [pub, priv] = row.value.split(":");
    if (!pub || !priv) return undefined;
    return { publicKey: unhex(pub), privateKey: unhex(priv) };
  }

  async setDeviceKey(key: DeviceKey): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('deviceKey', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(`${hex(key.publicKey)}:${hex(key.privateKey)}`);
  }
```

Adjust to this adapter's driver seam — it wraps statements rather than calling `better-sqlite3` directly.

- [ ] **Step 6: Run the tests**

Run: `npm test -w @tangentfeed/core -- device-key-storage`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core packages/adapter-idb packages/adapter-sqlite
git commit -m "feat(storage): persist the device signing keypair"
```

---

### Task 5: Engine — sign on write, verify on apply

**Files:**
- Modify: `packages/core/src/engine.ts`
- Test: `packages/core/test/engine-signing.test.ts`

**Interfaces:**
- Consumes: `signedPayload`, `verifyOp` (Task 3); `getDeviceKey`/`setDeviceKey` (Task 4).
- Produces: `SyncEngine.open({ storage, physicalClock? })` — `deviceId` is no longer a parameter; `SyncEngine.publicKey: Uint8Array`; `SyncEngine.knownKeys(): Map<string, Uint8Array>`; `SyncEngine.learnKey(deviceId, publicKey): boolean`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/engine-signing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SyncEngine, MemoryAdapter, generateDeviceKey, deviceIdFromPublicKey } from "../src/index.js";

const open = (storage = new MemoryAdapter()) =>
  SyncEngine.open({ storage, physicalClock: () => 0x018f6e2bffff });

describe("engine signing", () => {
  it("generates and persists a keypair on first open", async () => {
    const storage = new MemoryAdapter();
    const engine = await open(storage);
    const stored = await storage.getDeviceKey();
    expect(stored).toBeDefined();
    expect(engine.deviceId).toBe(deviceIdFromPublicKey(stored!.publicKey));
  });

  it("keeps the same identity across reopen", async () => {
    const storage = new MemoryAdapter();
    const first = await open(storage);
    const second = await open(storage);
    expect(second.deviceId).toBe(first.deviceId);
  });

  it("signs every op it writes", async () => {
    const engine = await open();
    const id = await engine.insert("tasks", { title: "signed" });
    const ops = await engine.opsSince({});
    expect(ops).toHaveLength(1);
    expect(ops[0]!.sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(ops[0]!.row).toBe(id);
  });

  it("accepts a correctly signed remote op once the key is known", async () => {
    const a = await open();
    const b = await open();
    b.learnKey(a.deviceId, a.publicKey);

    await a.insert("tasks", { title: "from a" });
    const applied = await b.applyRemoteOps(await a.opsSince({}));
    expect(applied).toBe(1);
  });

  it("rejects a remote op from an unknown device", async () => {
    const a = await open();
    const b = await open();
    await a.insert("tasks", { title: "from a" });

    await expect(b.applyRemoteOps(await a.opsSince({}))).rejects.toThrow(/unknown device/i);
  });

  it("rejects a tampered op even from a known device", async () => {
    const a = await open();
    const b = await open();
    b.learnKey(a.deviceId, a.publicKey);

    await a.insert("tasks", { title: "original" });
    const [op] = await a.opsSince({});
    await expect(b.applyRemoteOps([{ ...op!, value: "tampered" }])).rejects.toThrow(/signature/i);
  });

  it("rejects a key that does not hash to its claimed deviceId", async () => {
    const engine = await open();
    const other = generateDeviceKey();
    expect(engine.learnKey("0".repeat(32), other.publicKey)).toBe(false);
  });

  it("writes nothing when one op in a batch fails verification", async () => {
    const a = await open();
    const b = await open();
    b.learnKey(a.deviceId, a.publicKey);

    await a.insert("tasks", { title: "one" });
    await a.insert("tasks", { title: "two" });
    const ops = await a.opsSince({});

    await expect(
      b.applyRemoteOps([ops[0]!, { ...ops[1]!, value: "tampered" }]),
    ).rejects.toThrow();
    expect(await b.dump()).toEqual({});
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @tangentfeed/core -- engine-signing`
Expected: FAIL — `SyncEngine.open` still requires `deviceId`.

- [ ] **Step 3: Implement**

In `packages/core/src/engine.ts`:

Replace the `open` signature and body's identity handling:

```ts
  static async open(opts: {
    storage: StorageAdapter;
    physicalClock?: () => number;
  }): Promise<SyncEngine> {
    let key = await opts.storage.getDeviceKey();
    if (!key) {
      // Claim an identity before any data op, so it survives being killed early.
      key = generateDeviceKey();
      await opts.storage.setDeviceKey(key);
    }
    const deviceId = deviceIdFromPublicKey(key.publicKey);
    const persisted = await opts.storage.getClock();
    const clock = new HybridLogicalClock({
      deviceId,
      ...(opts.physicalClock ? { physicalClock: opts.physicalClock } : {}),
      millis: persisted?.millis ?? 0,
      counter: persisted?.counter ?? 0,
    });
    return new SyncEngine(opts.storage, clock, key);
  }
```

Add fields and the key directory:

```ts
  private readonly deviceKey: DeviceKey;
  private readonly keys = new Map<string, Uint8Array>();

  get publicKey(): Uint8Array {
    return this.deviceKey.publicKey;
  }

  knownKeys(): Map<string, Uint8Array> {
    return new Map(this.keys);
  }

  /**
   * Records a peer's public key. Returns false if it does not hash to the
   * claimed id, which is what makes the key directory self-validating: a peer
   * cannot inject a false key for someone else.
   */
  learnKey(deviceId: string, publicKey: Uint8Array): boolean {
    if (deviceIdFromPublicKey(publicKey) !== deviceId) return false;
    this.keys.set(deviceId, publicKey);
    return true;
  }
```

The constructor takes the key as a third parameter and seeds the directory with its own entry, so an engine can always verify its own ops:

```ts
  private constructor(storage: StorageAdapter, clock: HybridLogicalClock, key: DeviceKey) {
    this.storage = storage;
    this.clock = clock;
    this.deviceKey = key;
    this.keys.set(clock.deviceId, key.publicKey);
  }
```

Sign in `makeLocalOp` — build the op without `sig`, then attach it:

```ts
  private makeLocalOp(table: string, row: string, column: string, value: Json): Op {
    const hlc = encodeHlc(this.clock.now());
    const unsigned = { id: hlc, table, row, column, value, hlc, device: this.clock.deviceId };
    const op = { ...unsigned, sig: signPayload(signedPayload(unsigned), this.deviceKey.privateKey) };
    validateOp(op);
    return op;
  }
```

Verify in `applyRemoteOps`, before the drift check that is already there:

```ts
    for (const raw of remoteOps) {
      validateOp(raw);
      const op = raw as Op;

      const publicKey = this.keys.get(op.device);
      if (!publicKey) {
        throw new BadOpError(`unknown device ${op.device}; no key to verify against`);
      }
      if (!verifyOp(op, publicKey)) {
        throw new BadOpError(`bad signature on op ${op.id}`);
      }

      this.clock.receive(decodeHlc(op.hlc));   // existing drift check
      ops.push(op);
    }
```

Both throws happen before any write, so a batch containing one bad op leaves nothing behind — the property the last test checks.

- [ ] **Step 4: Run the tests**

Run: `npm test -w @tangentfeed/core -- engine-signing`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): sign local ops, verify remote ops against a key directory"
```

---

### Task 6: Session — carry keys between peers

**Files:**
- Modify: `packages/core/src/replicator.ts`
- Test: `packages/core/test/replicator-keys.test.ts`

**Interfaces:**
- Consumes: `knownKeys`, `learnKey`, `publicKey` (Task 5).
- Produces: `hello` gains `key` (hex); a new `keys` message `{ t: "keys", keys: Record<deviceId, hexPublicKey> }`; `WIRE_VERSION` becomes `2`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/replicator-keys.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SyncEngine, MemoryAdapter, WIRE_VERSION, syncOnce } from "../src/index.js";

const open = () =>
  SyncEngine.open({ storage: new MemoryAdapter(), physicalClock: () => 0x018f6e2bffff });

describe("key exchange", () => {
  it("declares wire version 2", () => {
    expect(WIRE_VERSION).toBe(2);
  });

  it("syncOnce exchanges keys before ops, so two fresh peers converge", async () => {
    const a = await open();
    const b = await open();
    await a.insert("tasks", { title: "from a" });
    await b.insert("tasks", { title: "from b" });

    await syncOnce(a, b);

    expect(Object.keys((await a.dump()).tasks ?? {})).toHaveLength(2);
    expect(await b.dump()).toEqual(await a.dump());
  });

  it("a third peer learns the first peer's key transitively", async () => {
    const a = await open();
    const b = await open();
    const c = await open();

    await a.insert("tasks", { title: "from a" });
    await syncOnce(a, b);   // b learns a's key and a's op
    await syncOnce(b, c);   // c must learn a's key from b, not from a

    expect(c.knownKeys().has(a.deviceId)).toBe(true);
    expect(Object.keys((await c.dump()).tasks ?? {})).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @tangentfeed/core -- replicator-keys`
Expected: FAIL — `WIRE_VERSION` is 1.

- [ ] **Step 3: Implement**

In `packages/core/src/replicator.ts`:

```ts
export const WIRE_VERSION = 2;

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
```

`hello` gains the sender's own key:

```ts
      { t: "hello", v: WIRE_VERSION, space: this.space, clock, key: hex(this.engine.publicKey) }
```

On receiving `hello`, learn that key, then send the directory before anything else:

```ts
      case "hello": {
        if (msg.space !== this.space) throw new Error("SPACE_MISMATCH");
        if (typeof msg.key === "string") this.engine.learnKey(from, unhex(msg.key));
        await this.sendKeys(peer);
        break;
      }
      case "keys": {
        const entries = (msg.keys ?? {}) as Record<string, string>;
        // learnKey discards any entry that does not hash to its claimed id,
        // so a peer cannot inject a false key for someone else.
        for (const [id, k] of Object.entries(entries)) this.engine.learnKey(id, unhex(k));
        break;
      }
```

with:

```ts
  private async sendKeys(peer?: string): Promise<void> {
    const keys: Record<string, string> = {};
    for (const [id, k] of this.engine.knownKeys()) keys[id] = hex(k);
    await this.transport.send({ t: "keys", keys }, peer);
  }
```

`sendKeys` must also run immediately before the first `ops` message in `_sendOpsSince`, so a peer never receives an op it cannot verify.

Update `syncOnce` to exchange directories first:

```ts
export async function syncOnce(a: SyncEngine, b: SyncEngine): Promise<void> {
  for (const [id, k] of a.knownKeys()) b.learnKey(id, k);
  for (const [id, k] of b.knownKeys()) a.learnKey(id, k);
  // ... existing frontier exchange, unchanged
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w @tangentfeed/core -- replicator-keys`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): exchange device keys in the sync session, wire version 2"
```

---

### Task 7: Regenerate every conformance vector

All nine files carry hand-written 16-character deviceIds and unsigned ops. Both are now invalid.

**Files:**
- Create: `conformance/regenerate.mjs`
- Modify: every file in `conformance/merge/`, `conformance/hlc/`, `conformance/session/`
- Modify: `packages/core/test/conformance.test.ts` (fixture deviceIds only)

- [ ] **Step 1: Write the regenerator**

`conformance/regenerate.mjs` reads each existing vector, rewrites every deviceId to a derived one from a fixed set of test keys, re-encodes every HLC string, and signs every op. Fixed keys keep the output reproducible.

```js
/**
 * Rewrites the vectors for protocol v0.2.
 *
 *   node conformance/regenerate.mjs
 *
 * Every 16-character deviceId becomes a 32-character derived one, every HLC
 * string is re-encoded at the new width, and every op is signed. The mapping
 * from old id to new key is fixed so the output is reproducible.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const DOMAIN = "tangentfeed/v2/op";

function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).sort()
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

// old 16-char id -> deterministic private key seed
const identities = new Map();
function identityFor(oldId) {
  if (!identities.has(oldId)) {
    const seed = sha256(new TextEncoder().encode(`tangentfeed-test-key:${oldId}`));
    const publicKey = ed25519.getPublicKey(seed);
    identities.set(oldId, { privateKey: seed, publicKey, deviceId: hex(sha256(publicKey).slice(0, 16)) });
  }
  return identities.get(oldId);
}

const HLC_RE = /^([0-9a-f]{12})-([0-9a-f]{4})-([0-9a-f]{16})$/;

const rewriteHlc = (s) => {
  const m = HLC_RE.exec(s);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${identityFor(m[3]).deviceId}`;
};

function rewrite(value) {
  if (typeof value === "string") return rewriteHlc(value);
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === "device" && /^[0-9a-f]{16}$/.test(v) ? identityFor(v).deviceId : rewrite(v);
    }
    return out;
  }
  return value;
}

function signOp(op) {
  const { sig: _drop, ...rest } = op;
  const identity = [...identities.values()].find((i) => i.deviceId === rest.device);
  if (!identity) throw new Error(`no key for device ${rest.device}`);
  const payload = new TextEncoder().encode(DOMAIN + canonicalJson(rest));
  return { ...rest, sig: Buffer.from(ed25519.sign(payload, identity.privateKey)).toString("base64") };
}

for (const dir of ["merge", "hlc", "session"]) {
  for (const file of readdirSync(join("conformance", dir)).filter((f) => f.endsWith(".json"))) {
    const path = join("conformance", dir, file);
    const doc = rewrite(JSON.parse(readFileSync(path, "utf8")));

    for (const field of ["ops", "localOps", "remoteOps"]) {
      if (Array.isArray(doc[field])) doc[field] = doc[field].map(signOp);
    }

    writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
    console.log(`rewrote ${path}`);
  }
}
```

- [ ] **Step 2: Run it**

```bash
node conformance/regenerate.mjs
```

- [ ] **Step 3: Fix the two things the regenerator cannot infer**

`hlc/01-encoding.json` contains `deviceId` fields inside `encode` cases and literal `invalid` strings. Update by hand:

- every `"deviceId": "<16 hex>"` becomes the corresponding derived 32-character id, and its `expected` string re-encodes at 50 characters
- in `invalid`, change `"deviceId must be exactly 16 hex characters"` to `"deviceId must be exactly 32 hex characters"` and make its input a 16-character id, which is now malformed

`hlc/02-send-receive.json` has a top-level `deviceId`; give it a derived one.

- [ ] **Step 4: Update the core conformance harness**

`packages/core/test/conformance.test.ts` opens its engine with a hardcoded `deviceId: "1234567890abcdef"`. `SyncEngine.open` no longer takes one — remove the argument. The harness's engine identity is irrelevant to merge outcomes, since every op is remote.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. Any remaining failure is a vector the regenerator missed; fix the vector, not the test.

- [ ] **Step 6: Commit**

```bash
git add conformance packages/core/test/conformance.test.ts
git commit -m "test(conformance): regenerate every vector for signed ops and 128-bit deviceIds"
```

---

### Task 8: Facade, transports and the protocol document

**Files:**
- Modify: `packages/tangentfeed/src/index.ts`
- Modify: `packages/adapter-sqlite/src/index.ts` and `packages/transport-webrtc/src/index.ts` (deviceId generation call sites)
- Modify: `PROTOCOL.md`
- Modify: `README.md`, `packages/core/README.md`
- Test: `packages/tangentfeed/test/api.test.ts` (existing, adjust)

- [ ] **Step 1: Remove `deviceId` from the public API**

`OpenSpaceOptions` loses its `deviceId` field and its doc comment about persisting it yourself — identity now comes from storage. `openSpace` stops calling `generateDeviceId` and lets `SyncEngine.open` derive it. `SyncedSpace` keeps `deviceId` as a read-only property.

Every remaining call site of `generateDeviceId` is a compile error; each one either reads `engine.deviceId` or, in `transport-webrtc`, takes the deviceId it is already given.

- [ ] **Step 2: Run the suite**

Run: `npm test && npm run build`
Expected: PASS and a clean build.

- [ ] **Step 3: Update PROTOCOL.md**

- §3: add `sig` to the field table — `string`, "base64 Ed25519 signature over §12's payload"; change "exactly these fields" to eight.
- §3.1: wire version becomes `2`.
- §4.2: width becomes `{12}-{4}-{32}`, total 50; update the worked example.
- §4.3: replace "16 lowercase hex characters (64 random bits), generated once per device per space and persisted" with derivation from the public key, 32 characters, 128 bits, and why the width changed.
- §6.1: `hello` gains `key`; add the `keys` row.
- New §12 "Operation signatures": the payload definition, encrypt-then-sign and why it is forced, the self-validating key directory, and that an op from an unknown device is rejected rather than queued.
- Appendix B: add `signatures/` to the coverage table.
- §1 non-goals: state that membership, roles and revocation are not in v0.2 — signatures prove *who* wrote an op, not that they were *allowed* to.

- [ ] **Step 4: Correct the zero-dependency claims**

`README.md`'s package table and `packages/core/README.md` both say core has zero dependencies. It now depends on `@noble/curves` and `@noble/hashes`. Change both to "Two audited dependencies (`@noble/curves`, `@noble/hashes`)".

- [ ] **Step 5: Update the roadmap**

Add to `ROADMAP.md` under Post-v0.1:

```markdown
- [x] Signed operations (protocol v0.2, phase 1): every op carries an Ed25519
  signature and deviceId derives from the public key, so ops cannot be forged
  and identities cannot be claimed without the key. Keys travel in the sync
  session and the directory is self-validating. Phase 1 of four — it does not
  yet stop an unauthorised peer from participating; that is the membership
  roster in phase 2.
```

- [ ] **Step 6: Full verification and commit**

```bash
npm test && npm run build
git add -A
git commit -m "feat: protocol v0.2 signed operations, docs and facade"
```

---

## Self-review notes

**Spec coverage.** Identity derivation → Task 1. 128-bit width → Tasks 1 and 3.
Key distribution → Task 6. Self-validating directory → Task 5 (`learnKey`) and
Task 6. Signed payload and domain separation → Tasks 1 and 3.
Encrypt-then-sign → enforced structurally, since the engine signs whatever
`value` holds after the cipher has run; covered by the encrypted-value case in
Task 2. Wire format and version → Tasks 3 and 6. Validation order → Task 5.
Storage methods → Task 4. Unknown-key rejection → Task 5. Blast radius →
Task 7. All five test categories → Tasks 2, 5, 6 and 7. Non-goals → Task 8's
protocol note.

**Deliberate omissions.** Two spec items have no task. The Dart implementation
is a separate plan, as the header says. Encrypting the stored private key is
recorded as follow-up in Task 4's doc comment rather than implemented, matching
the spec's own scoping.

**Type consistency.** `DeviceKey` is `{ publicKey, privateKey }` throughout
Tasks 1, 4 and 5. `signedPayload` takes `Omit<Op, "sig"> | Op` and returns
`Uint8Array` in Tasks 3 and 5. `learnKey(deviceId, publicKey): boolean` matches
between Tasks 5 and 6. `SIGNING_DOMAIN` is the single source of the domain
string in Tasks 1, 2 and 3.

**Known risk.** Task 3 moves `canonicalJson` and the signing primitives from
`@tangentfeed/crypto` into `@tangentfeed/core` to keep the dependency graph
acyclic. That is a larger refactor than it looks: `canonicalJson` is currently
exercised by `packages/crypto/test/canonical-vectors.test.ts`, which must keep
passing against the re-export.
