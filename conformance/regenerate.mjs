/**
 * Rewrites the vectors for protocol v0.2.
 *
 *   node conformance/regenerate.mjs
 *
 * Three things change, all forced by signed ops:
 *   - every 16-character deviceId becomes a 32-character derived one
 *   - every HLC string is re-encoded at the new width (34 -> 50 chars)
 *   - every op gains a signature
 *
 * The old id maps to a key deterministically, so running this twice produces
 * identical output and any implementation can reproduce it.
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
  return (
    "{" +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k]))
      .join(",") +
    "}"
  );
}

/** old 16-hex id -> a fixed keypair, so the mapping is stable across runs. */
const identities = new Map();
function identityFor(oldId) {
  let found = identities.get(oldId);
  if (!found) {
    const privateKey = sha256(new TextEncoder().encode(`tangentfeed-test-key:${oldId}`));
    const publicKey = ed25519.getPublicKey(privateKey);
    found = { privateKey, publicKey, deviceId: hex(sha256(publicKey).slice(0, 16)) };
    identities.set(oldId, found);
  }
  return found;
}

const OLD_HLC = /^([0-9a-f]{12})-([0-9a-f]{4})-([0-9a-f]{16})$/;
const OLD_DEVICE = /^[0-9a-f]{16}$/;

function rewrite(value, key) {
  if (typeof value === "string") {
    const m = OLD_HLC.exec(value);
    if (m) return `${m[1]}-${m[2]}-${identityFor(m[3]).deviceId}`;
    // bare device ids appear as object keys (frontiers) and as `device` fields
    if (OLD_DEVICE.test(value) && key !== "row") return identityFor(value).deviceId;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => rewrite(v));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const newKey = OLD_DEVICE.test(k) ? identityFor(k).deviceId : k;
      out[newKey] = rewrite(v, k);
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
  return {
    ...rest,
    sig: Buffer.from(ed25519.sign(payload, identity.privateKey)).toString("base64"),
  };
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

// The public keys the vectors are signed with. Every harness has to load these
// and learn them before applying any op, because an op from an unknown device
// is rejected (§12). Private keys are included so an implementation can
// regenerate or extend the vectors; they protect nothing.
const keyFile = {
  name: "test-keys",
  description:
    "Key material for the conformance vectors. Derived deterministically from " +
    "the v0.1 device ids so the mapping is stable and reproducible. These keys " +
    "are public by construction and must never be used for real data.",
  keys: Object.fromEntries(
    [...identities.values()].map((i) => [
      i.deviceId,
      { publicKey: hex(i.publicKey), privateKey: hex(i.privateKey) },
    ]),
  ),
};

writeFileSync(
  join("conformance", "test-keys.json"),
  JSON.stringify(keyFile, null, 2) + "\n",
);
console.log("wrote conformance/test-keys.json");

console.log(`\n${identities.size} identities:`);
for (const [oldId, i] of identities) console.log(`  ${oldId} -> ${i.deviceId}`);
