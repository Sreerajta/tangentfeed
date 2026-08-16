/**
 * Generates cross-implementation fixtures using the TypeScript implementation.
 *
 * The AAD and key derivation in section 7.1 cannot be validated by a
 * self-round-trip — a wrong-but-consistent implementation passes that
 * trivially. Decrypting something the *other* implementation produced is the
 * only real check.
 *
 *   node test/interop_fixture.mjs > test/interop_fixture.json
 */

import { SpaceCipher } from "../../../packages/crypto/dist/index.js";

const SECRET = new Uint8Array(32);
for (let i = 0; i < 32; i++) SECRET[i] = i;

const cipher = new SpaceCipher(SECRET);

const OP_ID = "018bcfe56800-0000-aaaaaaaaaaaaaaaa";
const OTHER_OP_ID = "018bcfe56801-0000-aaaaaaaaaaaaaaaa";

const values = [
  "hello",
  42,
  true,
  null,
  { b: 1, a: [1, 2, { z: "x" }] },
  ["nested", { deep: { deeper: 3.5 } }],
  "unicode: é 日本 😀",
  "",
];

const cases = values.map((value) => ({
  value,
  opId: OP_ID,
  envelope: cipher.encrypt(value, OP_ID),
}));

// Same plaintext under a different op id, to prove the AAD is actually bound.
const aadCase = {
  value: "hello",
  opId: OTHER_OP_ID,
  envelope: cipher.encrypt("hello", OTHER_OP_ID),
  wrongOpId: OP_ID,
};

// Passphrase derivation. Section 7.1 leaves the KDF to the implementation, so
// this is the only thing pinning Dart's scrypt parameters to the reference's.
const PASSPHRASE = "correct horse battery staple";
const SPACE = "kitchen-42";
const passphraseCipher = await SpaceCipher.fromPassphrase(PASSPHRASE, SPACE);
const passphraseCase = {
  passphrase: PASSPHRASE,
  space: SPACE,
  value: { note: "derived from a passphrase", n: 7 },
  opId: OP_ID,
  envelope: passphraseCipher.encrypt({ note: "derived from a passphrase", n: 7 }, OP_ID),
};

console.log(
  JSON.stringify(
    {
      description:
        "Envelopes produced by the TypeScript implementation. A Dart peer must " +
        "decrypt every one, and must fail to decrypt aadMismatch under the wrong op id.",
      secret: Array.from(SECRET),
      cases,
      aadMismatch: aadCase,
      passphrase: passphraseCase,
    },
    null,
    2,
  ),
);
