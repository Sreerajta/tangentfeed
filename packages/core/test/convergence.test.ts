/**
 * Convergence — the property the whole library exists to provide.
 *
 * Model: N engines with skewed (but in-drift) clocks perform random writes,
 * deletes, and pairwise syncs in random order. After a final full exchange,
 * ALL engines must hold deep-equal materialized state and equal frontiers.
 *
 * Second property: the same set of ops, delivered to a fresh engine in any
 * order, any batching, with duplicates, produces the same state (op delivery
 * is commutative + idempotent).
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { SyncEngine, syncOnce } from "../src/engine.js";
import { MemoryAdapter } from "../src/storage.js";
import type { Op } from "../src/op.js";

const T0 = 1_700_000_000_000;
const TABLES = ["tasks", "notes"];
const COLUMNS = ["title", "done", "count"];

interface Sim {
  engines: SyncEngine[];
  rowIds: string[]; // rows created so far, shared pool
}

async function makeEngines(n: number, step: () => number): Promise<SyncEngine[]> {
  return Promise.all(
    Array.from({ length: n }, (_, i) => {
      const skew = ((i * 7919) % 40_000) - 20_000; // ±20s per-device skew
      return SyncEngine.open({
        deviceId: i.toString(16).padStart(16, "0"),
        storage: new MemoryAdapter(),
        physicalClock: () => T0 + step() * 10 + skew,
      });
    }),
  );
}

const arbEvent = fc.record({
  actor: fc.nat(4),
  kind: fc.constantFrom<"insert" | "update" | "delete" | "sync">(
    "insert",
    "update",
    "update", // weight updates higher
    "delete",
    "sync",
    "sync",
  ),
  target: fc.nat(4), // sync peer, or row index for update/delete
  tableIdx: fc.nat(1),
  colIdx: fc.nat(2),
  value: fc.oneof(
    fc.string({ maxLength: 8 }),
    fc.boolean(),
    fc.integer({ min: -1000, max: 1000 }),
    fc.constant(null),
  ),
});

describe("multi-engine convergence", () => {
  it("random writes + random gossip → identical state everywhere", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 4 }),
        fc.array(arbEvent, { minLength: 20, maxLength: 120 }),
        async (n, events) => {
          let stepCount = 0;
          const step = () => stepCount;
          const sim: Sim = { engines: await makeEngines(n, step), rowIds: [] };

          for (const ev of events) {
            stepCount += 1;
            const e = sim.engines[ev.actor % n]!;
            const table = TABLES[ev.tableIdx % TABLES.length]!;
            const column = COLUMNS[ev.colIdx % COLUMNS.length]!;
            switch (ev.kind) {
              case "insert": {
                sim.rowIds.push(await e.insert(table, { [column]: ev.value }));
                break;
              }
              case "update": {
                const row = sim.rowIds[ev.target % Math.max(1, sim.rowIds.length)];
                if (row) await e.update(table, row, { [column]: ev.value });
                break;
              }
              case "delete": {
                const row = sim.rowIds[ev.target % Math.max(1, sim.rowIds.length)];
                if (row) await e.delete(table, row);
                break;
              }
              case "sync": {
                const peer = sim.engines[ev.target % n]!;
                if (peer !== e) await syncOnce(e, peer);
                break;
              }
            }
          }

          // quiescence: full round-robin exchanges until stable
          for (let round = 0; round < n; round++) {
            for (let i = 0; i < n; i++) {
              for (let j = i + 1; j < n; j++) {
                stepCount += 1;
                await syncOnce(sim.engines[i]!, sim.engines[j]!);
              }
            }
          }

          const dumps = await Promise.all(sim.engines.map((e) => e.dump()));
          const frontiers = await Promise.all(sim.engines.map((e) => e.frontier()));
          for (let i = 1; i < n; i++) {
            expect(dumps[i]).toEqual(dumps[0]);
            expect(frontiers[i]).toEqual(frontiers[0]);
          }
        },
      ),
      { numRuns: 60 },
    );
  }, 120_000);

  it("same ops, any delivery order/batching/duplication → same state", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbEvent, { minLength: 15, maxLength: 60 }),
        fc.infiniteStream(fc.nat(1_000_000)),
        async (events, rng) => {
          // Phase 1: generate a real op corpus by running a 2-engine sim
          let stepCount = 0;
          const step = () => stepCount;
          const sim: Sim = { engines: await makeEngines(2, step), rowIds: [] };
          for (const ev of events) {
            stepCount += 1;
            const e = sim.engines[ev.actor % 2]!;
            const table = TABLES[ev.tableIdx % TABLES.length]!;
            const column = COLUMNS[ev.colIdx % COLUMNS.length]!;
            if (ev.kind === "insert") {
              sim.rowIds.push(await e.insert(table, { [column]: ev.value }));
            } else if (ev.kind === "update" && sim.rowIds.length) {
              await e.update(table, sim.rowIds[ev.target % sim.rowIds.length]!, {
                [column]: ev.value,
              });
            } else if (ev.kind === "delete" && sim.rowIds.length) {
              await e.delete(table, sim.rowIds[ev.target % sim.rowIds.length]!);
            }
          }
          const corpus: Op[] = [
            ...(await sim.engines[0]!.opsSince({})),
            ...(await sim.engines[1]!.opsSince({})),
          ];

          // Reference state: apply in HLC order to a fresh engine
          const next = () => rng.next().value as number;
          const fresh = async () =>
            SyncEngine.open({
              deviceId: "feedfacefeedface",
              storage: new MemoryAdapter(),
              physicalClock: () => T0 + stepCount * 10 + 60_000,
            });
          const ref = await fresh();
          await ref.applyRemoteOps([...corpus].sort((a, b) => (a.hlc < b.hlc ? -1 : 1)));
          const want = await ref.dump();

          // Chaos delivery: shuffle, duplicate ~30%, random batch sizes
          const chaos = [...corpus, ...corpus.filter(() => next() % 10 < 3)];
          for (let i = chaos.length - 1; i > 0; i--) {
            const j = next() % (i + 1);
            [chaos[i], chaos[j]] = [chaos[j]!, chaos[i]!];
          }
          const e = await fresh();
          let idx = 0;
          while (idx < chaos.length) {
            const size = 1 + (next() % 7);
            await e.applyRemoteOps(chaos.slice(idx, idx + size));
            idx += size;
          }
          expect(await e.dump()).toEqual(want);
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);
});
