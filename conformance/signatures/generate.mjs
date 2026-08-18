/**
 * Regenerates the signature vectors.
 *
 *   node conformance/signatures/generate.mjs > conformance/signatures/01-op-signatures.json
 *
 * The private key is fixed and committed on purpose: these vectors must be
 * reproducible byte for byte in every implementation, which a random key
 * cannot be. It protects nothing and must never be used for real data.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

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
  {
    description: "a nested object value, canonicalised before signing",
    op: mkOp({ column: "place", value: { lon: 2, lat: 1 } }),
  },
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
    description: "the row was changed after signing",
    op: { ...valid.op, row: "01HZX3NDEKTSV4RRFFQ69G5FBB", sig: valid.expectedSignature },
    reason: "TAMPERED_ROW",
  },
  {
    description: "the hlc was moved earlier, to win a merge it should lose",
    op: {
      ...valid.op,
      hlc: hlc(0x018bcfe56700, 0),
      id: hlc(0x018bcfe56700, 0),
      sig: valid.expectedSignature,
    },
    reason: "TAMPERED_HLC",
  },
  {
    description: "a signature lifted from a different op",
    op: { ...cases[1].op, sig: valid.expectedSignature },
    reason: "SIGNATURE_FROM_ANOTHER_OP",
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
        "Ed25519 signatures over the canonical JSON of an op, domain-separated with " +
        '"tangentfeed/v2/op". The private key is fixed so the vectors are reproducible; ' +
        "it protects nothing. The negative cases carry the weight: a verifier that " +
        "returns true unconditionally passes every positive case here.",
      domain: DOMAIN,
      testKey: { privateKey: hex(privateKey), publicKey: hex(publicKey), deviceId },
      cases,
      negative,
    },
    null,
    2,
  ),
);
