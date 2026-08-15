/**
 * Sync session conformance vectors (§6).
 *
 * Merge vectors prove a replica converges once it has the ops. These prove it
 * asks for and hands over the right ops in the first place — the part two
 * implementations must agree on before they can talk at all.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SyncEngine } from "../src/engine.js";
import { MemoryAdapter } from "../src/storage.js";
import type { Frontier, Op } from "../src/op.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../conformance/session");

interface Vector {
  name: string;
  description: string;
  localDevice: string;
  remoteDevice: string;
  localOps: Op[];
  remoteOps: Op[];
  advertisedFrontier: { description: string; expected: Frontier };
  diffCases: { description: string; peerFrontier: Frontier; expectedOpIds: string[] }[];
  afterApplyingRemote: {
    description: string;
    expectedState: Record<string, Record<string, Record<string, unknown>>>;
    expectedFrontier: Frontier;
  };
}

const vectors: Vector[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Vector);

async function engineWith(deviceId: string, ops: readonly Op[]): Promise<SyncEngine> {
  const engine = await SyncEngine.open({ deviceId, storage: new MemoryAdapter() });
  await engine.applyRemoteOps(ops);
  return engine;
}

const materialize = (engine: SyncEngine) => engine.dump();

describe("sync session vectors", () => {
  it("finds vector files", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const v of vectors) {
    describe(v.name, () => {
      it(`advertises the right frontier: ${v.advertisedFrontier.description}`, async () => {
        const local = await engineWith(v.localDevice, v.localOps);
        expect(await local.frontier()).toEqual(v.advertisedFrontier.expected);
      });

      for (const c of v.diffCases) {
        it(`sends the right ops: ${c.description}`, async () => {
          const local = await engineWith(v.localDevice, v.localOps);
          const sent = await local.opsSince(c.peerFrontier);
          expect(sent.map((o) => o.id).sort()).toEqual([...c.expectedOpIds].sort());
        });
      }

      it(`converges after applying remote ops: ${v.afterApplyingRemote.description}`, async () => {
        const local = await engineWith(v.localDevice, v.localOps);
        await local.applyRemoteOps(v.remoteOps);
        expect(await materialize(local)).toEqual(v.afterApplyingRemote.expectedState);
        expect(await local.frontier()).toEqual(v.afterApplyingRemote.expectedFrontier);
      });

      it("both peers reach the same state regardless of who applies first", async () => {
        const a = await engineWith(v.localDevice, v.localOps);
        await a.applyRemoteOps(v.remoteOps);

        const b = await engineWith(v.remoteDevice, v.remoteOps);
        await b.applyRemoteOps(v.localOps);

        expect(await materialize(b)).toEqual(await materialize(a));
        expect(await b.frontier()).toEqual(await a.frontier());
      });

      it("replaying the whole exchange changes nothing (idempotent reconnect)", async () => {
        const local = await engineWith(v.localDevice, v.localOps);
        await local.applyRemoteOps(v.remoteOps);
        const once = await materialize(local);

        await local.applyRemoteOps(v.remoteOps);
        await local.applyRemoteOps(v.localOps);

        expect(await materialize(local)).toEqual(once);
        expect(await local.frontier()).toEqual(v.afterApplyingRemote.expectedFrontier);
      });
    });
  }
});
