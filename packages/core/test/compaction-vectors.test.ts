/**
 * Compaction conformance vectors (§9).
 *
 * Compaction is the one part of the protocol whose result depends on a whole
 * replica's history rather than a batch of ops, which is why these vectors
 * carry recorded peer frontiers alongside the log.
 *
 * `stateUnchanged` is the assertion that matters. Compaction reclaims storage;
 * a compaction that alters what a reader sees is a data-loss bug, and every
 * other number here is secondary to that.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SyncEngine } from "../src/engine.js";
import { MemoryAdapter } from "../src/storage.js";
import { learnTestKeys } from "./test-keys.js";
import type { Frontier, Op } from "../src/op.js";

const FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../conformance/compaction/01-compaction.json",
);

interface Vector {
  name: string;
  description: string;
  ops: Op[];
  peerFrontiers: Record<string, Frontier>;
  options: { includeTombstones?: boolean; dryRun?: boolean };
  expected: {
    removed: number;
    rowsReclaimed: number;
    blockedBy: string[];
    opCountAfter: number;
    stateUnchanged: boolean;
  };
}

const suite = JSON.parse(readFileSync(FILE, "utf8")) as { vectors: Vector[] };

async function replicaFor(v: Vector): Promise<SyncEngine> {
  const storage = new MemoryAdapter();
  const engine = await SyncEngine.open({
    storage,
    physicalClock: () => 0x018f6e2b_ffff,
  });
  learnTestKeys(engine);
  await engine.applyRemoteOps(v.ops);
  for (const [peer, frontier] of Object.entries(v.peerFrontiers)) {
    await engine.recordPeerFrontier(peer, frontier);
  }
  return engine;
}

describe("compaction vectors (§9)", () => {
  it("found vectors to run", () => {
    expect(suite.vectors.length).toBeGreaterThan(0);
  });

  for (const v of suite.vectors) {
    describe(v.name, () => {
      it(`reclaims what it should: ${v.description}`, async () => {
        const engine = await replicaFor(v);
        const stats = await engine.compact(v.options);

        expect(stats.removed).toBe(v.expected.removed);
        expect(stats.rowsReclaimed).toBe(v.expected.rowsReclaimed);
        expect([...stats.blockedBy].sort()).toEqual([...v.expected.blockedBy].sort());
      });

      it("leaves the log at the expected size", async () => {
        const engine = await replicaFor(v);
        await engine.compact(v.options);
        expect(await engine.opCount()).toBe(v.expected.opCountAfter);
      });

      it("does not change what a reader sees", async () => {
        const engine = await replicaFor(v);
        const before = await engine.dump();
        await engine.compact(v.options);
        expect(await engine.dump()).toEqual(before);
      });

      it("is idempotent: compacting twice removes nothing more", async () => {
        const engine = await replicaFor(v);
        await engine.compact(v.options);
        const afterFirst = await engine.opCount();
        const second = await engine.compact(v.options);
        expect(await engine.opCount()).toBe(afterFirst);
        if (!v.options.dryRun) expect(second.removed).toBe(0);
      });

      it("a replica that compacted still converges with one that did not", async () => {
        // The point of the horizon: a compacted replica must remain a valid
        // sync partner. If it dropped something a peer still needed, this is
        // where it shows.
        const compacted = await replicaFor(v);
        await compacted.compact(v.options);

        const fresh = await replicaFor(v);
        await fresh.applyRemoteOps(await compacted.opsSince({}));

        expect(await fresh.dump()).toEqual(await compacted.dump());
      });
    });
  }
});
