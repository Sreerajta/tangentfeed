/**
 * The keypairs the conformance vectors are signed with.
 *
 * An op from a device whose key is unknown is rejected (§12), so every harness
 * that replays vectors has to learn these first. That is not a test
 * concession — it is the same `keys` exchange a real peer performs before it
 * accepts anything (§6.1).
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SyncEngine } from "../src/index.js";

const FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../conformance/test-keys.json",
);

interface KeyFile {
  keys: Record<string, { publicKey: string; privateKey: string }>;
}

const unhex = (s: string): Uint8Array =>
  new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

const file = JSON.parse(readFileSync(FILE, "utf8")) as KeyFile;

/** deviceId -> public key, for every identity used by the vectors. */
export const testPublicKeys: ReadonlyMap<string, Uint8Array> = new Map(
  Object.entries(file.keys).map(([id, k]) => [id, unhex(k.publicKey)]),
);

/** deviceId -> private key, for harnesses that need to author their own ops. */
export const testPrivateKeys: ReadonlyMap<string, Uint8Array> = new Map(
  Object.entries(file.keys).map(([id, k]) => [id, unhex(k.privateKey)]),
);

/** Teaches an engine every vector identity. Call before replaying any vector. */
export function learnTestKeys(engine: SyncEngine): void {
  for (const [id, key] of testPublicKeys) {
    if (!engine.learnKey(id, key)) {
      throw new Error(`test key for ${id} does not hash to its own id`);
    }
  }
}

/**
 * Introduces engines to each other, as the `keys` exchange does in a real
 * session (§6.1).
 *
 * Without this, engines that swap ops directly reject them as coming from an
 * unknown device — which is correct, and is exactly what a peer that skipped
 * the handshake would see.
 */
export function link(...engines: SyncEngine[]): void {
  for (const a of engines) {
    for (const b of engines) {
      if (a !== b) b.learnKey(a.deviceId, a.publicKey);
    }
  }
}
