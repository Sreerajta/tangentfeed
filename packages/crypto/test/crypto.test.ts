import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  SyncEngine,
  MemoryAdapter,
  syncOnce,
  DecryptError,
  isEncryptedValue,
  type Json,
} from "@tangentfeed/core";
import { SpaceCipher, canonicalJson } from "../src/index.js";

const T0 = 1_700_000_000_000;
const SECRET = new Uint8Array(32).fill(7);
const OP_ID = "018f6e2a9c40-0000-aaaaaaaaaaaaaaaa";

const arbJson: fc.Arbitrary<Json> = fc.letrec<{ json: Json }>((tie) => ({
  json: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -1e6, max: 1e6 }),
    fc.string(),
    fc.array(tie("json"), { maxLength: 4 }),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), tie("json"), { maxKeys: 4 }),
  ),
})).json;

describe("SpaceCipher", () => {
  it("round-trips every JSON value shape", () => {
    const c = new SpaceCipher(SECRET);
    fc.assert(
      fc.property(arbJson, (value) => {
        expect(c.decrypt(c.encrypt(value, OP_ID), OP_ID)).toEqual(value);
      }),
    );
  });

  it("produces the e1: envelope and never leaks plaintext", () => {
    const c = new SpaceCipher(SECRET);
    const ct = c.encrypt("Buy oat milk at the corner shop", OP_ID);
    expect(isEncryptedValue(ct)).toBe(true);
    expect(ct).not.toContain("oat milk");
    expect(ct.startsWith("e1:")).toBe(true);
  });

  it("uses a fresh nonce per encryption (identical inputs → different ciphertexts)", () => {
    const c = new SpaceCipher(SECRET);
    const a = c.encrypt("same", OP_ID);
    const b = c.encrypt("same", OP_ID);
    expect(a).not.toBe(b);
    expect(c.decrypt(a, OP_ID)).toBe("same");
    expect(c.decrypt(b, OP_ID)).toBe("same");
  });

  it("rejects a wrong key", () => {
    const mine = new SpaceCipher(SECRET);
    const theirs = new SpaceCipher(new Uint8Array(32).fill(9));
    const ct = mine.encrypt("secret", OP_ID);
    expect(() => theirs.decrypt(ct, OP_ID)).toThrow(DecryptError);
  });

  it("AAD binding: a ciphertext moved to a different op fails authentication", () => {
    const c = new SpaceCipher(SECRET);
    const ct = c.encrypt("value for op A", OP_ID);
    const otherOpId = "018f6e2a9c41-0000-aaaaaaaaaaaaaaaa";
    expect(() => c.decrypt(ct, otherOpId)).toThrow(DecryptError);
  });

  it("rejects tampered ciphertext (bit flip anywhere)", () => {
    const c = new SpaceCipher(SECRET);
    const ct = c.encrypt({ balance: 100 }, OP_ID);
    const raw = ct.slice(3);
    for (const pos of [0, 12, 30, raw.length - 2]) {
      const ch = raw[pos]!;
      const flipped = raw.slice(0, pos) + (ch === "A" ? "B" : "A") + raw.slice(pos + 1);
      expect(() => c.decrypt("e1:" + flipped, OP_ID)).toThrow(DecryptError);
    }
  });

  it("passes through plaintext values (spaces predating encryption)", () => {
    const c = new SpaceCipher(SECRET);
    expect(c.decrypt("just a string", OP_ID)).toBe("just a string");
    expect(c.decrypt(42, OP_ID)).toBe(42);
    expect(c.decrypt(null, OP_ID)).toBe(null);
  });

  it("passphrase derivation is deterministic and salt-separated", async () => {
    const a = await SpaceCipher.fromPassphrase("correct horse battery staple", "space-1");
    const b = await SpaceCipher.fromPassphrase("correct horse battery staple", "space-1");
    const c = await SpaceCipher.fromPassphrase("correct horse battery staple", "space-2");
    const ct = a.encrypt("shared", OP_ID);
    expect(b.decrypt(ct, OP_ID)).toBe("shared"); // same passphrase+salt → same key
    expect(() => c.decrypt(ct, OP_ID)).toThrow(DecryptError); // different salt → different key
  }, 20_000);

  it("rejects dangerously short secrets", () => {
    expect(() => new SpaceCipher(new Uint8Array(8))).toThrow(/at least 16 bytes/);
  });
});

describe("canonicalJson (§8.1)", () => {
  it("sorts object keys and omits whitespace", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
    expect(canonicalJson([1, { b: 1, a: 2 }])).toBe('[1,{"a":2,"b":1}]');
  });

  it("key order does not change the canonical form", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 5 }), fc.integer(), { maxKeys: 6 }),
        (obj) => {
          const shuffled = Object.fromEntries(Object.entries(obj).reverse());
          expect(canonicalJson(shuffled as Json)).toBe(canonicalJson(obj as Json));
        },
      ),
    );
  });
});

describe("engine integration", () => {
  async function engine(n: number, cipher?: SpaceCipher) {
    return SyncEngine.open({
      storage: new MemoryAdapter(),
      physicalClock: () => T0 + n,
      ...(cipher ? { cipher } : {}),
    });
  }

  it("reads and writes transparently while storing only ciphertext", async () => {
    const cipher = new SpaceCipher(SECRET);
    const e = await engine(1, cipher);
    const id = await e.insert("tasks", { title: "Buy oat milk", done: false });

    // API surface is plaintext
    expect(await e.get("tasks", id)).toEqual({ id, title: "Buy oat milk", done: false });

    // the log is not
    const ops = await e.opsSince({});
    const titleOp = ops.find((o) => o.column === "title")!;
    expect(isEncryptedValue(titleOp.value)).toBe(true);
    expect(JSON.stringify(ops)).not.toContain("Buy oat milk");
  });

  it("two engines sharing a secret converge; the wire carries only ciphertext", async () => {
    const cipher = new SpaceCipher(SECRET);
    const a = await engine(1, cipher);
    const b = await engine(2, new SpaceCipher(SECRET));

    const id = await a.insert("tasks", { title: "Buy milk", done: false });
    await syncOnce(a, b);
    await a.update("tasks", id, { title: "Buy oat milk" });
    await b.update("tasks", id, { done: true });
    await syncOnce(a, b);

    const want = { id, title: "Buy oat milk", done: true };
    expect(await a.get("tasks", id)).toEqual(want);
    expect(await b.get("tasks", id)).toEqual(want);

    // what a relay would see
    const wire = JSON.stringify(await a.opsSince({}));
    expect(wire).not.toContain("Buy oat milk");
    expect(wire).toContain("e1:");
  });

  it("tombstones stay plaintext so peers without the key can still merge deletes", async () => {
    const cipher = new SpaceCipher(SECRET);
    const a = await engine(1, cipher);
    const id = await a.insert("tasks", { title: "doomed" });
    await a.delete("tasks", id);

    const tomb = (await a.opsSince({})).find((o) => o.column === "-")!;
    expect(tomb.value).toBe(true); // readable by anyone
    expect(await a.get("tasks", id)).toBeUndefined();

    // A keyless replica still hides the row correctly. "Keyless" means no
    // *cipher* key — it still needs a's signing key, because verifying a
    // signature never requires decrypting (§12, encrypt-then-sign).
    const blind = await engine(3);
    blind.learnKey(a.deviceId, a.publicKey);
    await blind.applyRemoteOps(await a.opsSince({}));
    expect(await blind.get("tasks", id)).toBeUndefined();
  });

  it("a peer with the wrong key syncs ops but cannot read values", async () => {
    const a = await engine(1, new SpaceCipher(SECRET));
    const intruder = await engine(2, new SpaceCipher(new Uint8Array(32).fill(3)));
    const id = await a.insert("tasks", { title: "confidential" });
    await syncOnce(a, intruder);

    // ops replicated fine (the protocol does not care)
    expect((await intruder.opsSince({})).length).toBe((await a.opsSince({})).length);
    // but the plaintext is unavailable
    await expect(intruder.get("tasks", id)).rejects.toThrow(DecryptError);
  });
});
