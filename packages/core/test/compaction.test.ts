/**
 * Compaction safety (§9).
 *
 * The load-bearing property: compaction must be INVISIBLE. Materialized state
 * never changes, and peers that sync afterwards still converge to exactly what
 * they would have without it.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { SyncEngine, syncOnce } from "../src/engine.js";
import { MemoryAdapter } from "../src/storage.js";
import { compactionHorizon, blockingPeers } from "../src/compaction.js";
import type { Frontier } from "../src/op.js";

const T0 = 1_700_000_000_000;
const dev = (n: number) => n.toString(16).padStart(16, "0");

async function engine(n: number, clock?: () => number) {
  return SyncEngine.open({
    deviceId: dev(n),
    storage: new MemoryAdapter(),
    physicalClock: clock ?? (() => T0 + n),
  });
}

describe("horizon math", () => {
  const A = dev(1);
  const B = dev(2);

  it("with no known peers, the horizon is our own frontier", () => {
    const own: Frontier = { [A]: "018f-0001-" + A, [B]: "018f-0002-" + B };
    expect(compactionHorizon(own, {})).toEqual(own);
  });

  it("takes the per-device minimum across peers", () => {
    const own: Frontier = { [A]: "300", [B]: "300" };
    const peers = {
      p1: { [A]: "200", [B]: "300" },
      p2: { [A]: "300", [B]: "100" },
    };
    expect(compactionHorizon(own, peers)).toEqual({ [A]: "200", [B]: "100" });
  });

  it("a peer that has seen nothing from a device pins that device to zero", () => {
    const own: Frontier = { [A]: "300" };
    expect(compactionHorizon(own, { p1: {} })).toEqual({ [A]: "" });
  });

  it("identifies which peers hold the horizon back", () => {
    const own: Frontier = { [A]: "300" };
    expect(blockingPeers(own, { fresh: { [A]: "300" }, stale: { [A]: "100" } })).toEqual([
      "stale",
    ]);
    expect(blockingPeers(own, { fresh: { [A]: "300" } })).toEqual([]);
  });
});

describe("compaction safety", () => {
  it("removes superseded ops but never winners; state is unchanged", async () => {
    const e = await engine(1);
    const id = await e.insert("tasks", { title: "v1", done: false });
    for (const title of ["v2", "v3", "v4", "v5"]) {
      await e.update("tasks", id, { title });
    }
    const before = await e.dump();
    expect(await e.opCount()).toBe(6); // 2 inserts + 4 updates

    const stats = await e.compact();
    expect(stats.removed).toBe(4); // the four superseded titles
    expect(stats.retainedWinners).toBe(2); // winning title + done
    expect(await e.opCount()).toBe(2);
    expect(await e.dump()).toEqual(before); // invisible
    expect((await e.get("tasks", id))!["title"]).toBe("v5");
  });

  it("dry run reports without touching storage", async () => {
    const e = await engine(1);
    const id = await e.insert("tasks", { title: "a" });
    await e.update("tasks", id, { title: "b" });
    const stats = await e.compact({ dryRun: true });
    expect(stats.removed).toBe(1);
    expect(await e.opCount()).toBe(2); // nothing actually deleted
  });

  it("never drops ops a known peer has not seen yet", async () => {
    const a = await engine(1);
    const b = await engine(2);
    const id = await a.insert("tasks", { title: "one" });
    await syncOnce(a, b); // b's frontier recorded on a

    // a keeps writing; b never syncs again
    await a.update("tasks", id, { title: "two" });
    await a.update("tasks", id, { title: "three" });

    const stats = await a.compact();
    // "one" is superseded AND b has seen it → safe to drop.
    // "two"/"three" are above b's frontier → must be kept, even though
    // "two" is superseded, because b would otherwise never learn of them.
    expect(stats.removed).toBe(1);
    expect(stats.retainedAboveHorizon).toBe(2);
    expect(stats.blockedBy).toEqual([b.deviceId]);
    expect(await a.opCount()).toBe(2);

    // b still converges correctly against the compacted log
    await syncOnce(a, b);
    expect((await b.get("tasks", id))!["title"]).toBe("three");

    // now that b has caught up, the superseded "two" becomes reclaimable
    const after = await a.compact();
    expect(after.removed).toBe(1);
    expect(after.blockedBy).toEqual([]);
    expect(await a.opCount()).toBe(1);
  });

  it("tombstones survive by default and their rows stay hidden", async () => {
    const e = await engine(1);
    const id = await e.insert("tasks", { title: "doomed" });
    await e.delete("tasks", id);

    const stats = await e.compact();
    expect(stats.rowsReclaimed).toBe(0);
    expect(await e.get("tasks", id)).toBeUndefined();

    // the tombstone op is still in the log, so it can still be replicated
    const peer = await engine(2);
    await peer.applyRemoteOps(await e.opsSince({}));
    expect(await peer.get("tasks", id)).toBeUndefined();
  });

  it("RESURRECTION HAZARD: tombstone GC only when the horizon has passed it", async () => {
    const a = await engine(1);
    const b = await engine(2, () => T0 + 5_000);
    const id = await a.insert("tasks", { title: "contested" });
    await syncOnce(a, b);

    // b writes to the row while offline; a deletes it
    await b.update("tasks", id, { title: "b still editing" });
    await a.delete("tasks", id);

    // a cannot GC the tombstone: b's frontier has not passed it
    const blocked = await a.compact({ includeTombstones: true });
    expect(blocked.rowsReclaimed).toBe(0);

    // after full sync both agree the row is gone, despite b's later write
    await syncOnce(a, b);
    await syncOnce(a, b);
    expect(await a.get("tasks", id)).toBeUndefined();
    expect(await b.get("tasks", id)).toBeUndefined();

    // now the horizon has passed the tombstone, so GC is permitted
    const allowed = await a.compact({ includeTombstones: true });
    expect(allowed.rowsReclaimed).toBe(1);
    expect(await a.get("tasks", id)).toBeUndefined(); // row forgotten entirely
  });

  it("compaction on one peer does not break convergence with another", async () => {
    const a = await engine(1);
    const b = await engine(2, () => T0 + 3);
    const id = await a.insert("tasks", { title: "v1", done: false });
    for (const t of ["v2", "v3"]) await a.update("tasks", id, { title: t });
    await syncOnce(a, b);

    await a.compact(); // a slims its log
    expect(await a.opCount()).toBeLessThan(4);

    // a fresh peer joining later still gets correct state from a
    const c = await engine(3, () => T0 + 6);
    await syncOnce(a, c);
    expect(await c.get("tasks", id)).toEqual({ id, title: "v3", done: false });
    expect(await c.dump()).toEqual(await a.dump());
  });
});

describe("convergence is preserved under compaction (property)", () => {
  it("random ops + random compaction → all replicas still agree", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            actor: fc.nat(2),
            kind: fc.constantFrom<"insert" | "update" | "delete" | "sync" | "compact">(
              "insert",
              "update",
              "update",
              "delete",
              "sync",
              "sync",
              "compact",
            ),
            target: fc.nat(4),
            value: fc.oneof(fc.string({ maxLength: 6 }), fc.boolean(), fc.integer()),
          }),
          { minLength: 20, maxLength: 80 },
        ),
        async (events) => {
          let step = 0;
          const engines = await Promise.all(
            [1, 2, 3].map((n) =>
              SyncEngine.open({
                deviceId: dev(n),
                storage: new MemoryAdapter(),
                physicalClock: () => T0 + step * 10 + n,
              }),
            ),
          );
          const rows: string[] = [];

          for (const ev of events) {
            step += 1;
            const e = engines[ev.actor]!;
            switch (ev.kind) {
              case "insert":
                rows.push(await e.insert("tasks", { title: String(ev.value) }));
                break;
              case "update":
                if (rows.length)
                  await e.update("tasks", rows[ev.target % rows.length]!, {
                    title: String(ev.value),
                  });
                break;
              case "delete":
                if (rows.length) await e.delete("tasks", rows[ev.target % rows.length]!);
                break;
              case "sync": {
                const peer = engines[(ev.actor + 1 + (ev.target % 2)) % 3]!;
                if (peer !== e) await syncOnce(e, peer);
                break;
              }
              case "compact":
                await e.compact();
                break;
            }
          }

          // quiescence, with compaction interleaved
          for (let round = 0; round < 3; round++) {
            for (let i = 0; i < 3; i++) {
              for (let j = i + 1; j < 3; j++) {
                step += 1;
                await syncOnce(engines[i]!, engines[j]!);
              }
            }
            await engines[round % 3]!.compact();
          }

          const dumps = await Promise.all(engines.map((e) => e.dump()));
          expect(dumps[1]).toEqual(dumps[0]);
          expect(dumps[2]).toEqual(dumps[0]);
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);
});

describe("bounded growth (soak)", () => {
  it("log size tracks live cells, not write count", async () => {
    const e = await engine(1);
    const ROWS = 50;
    const WRITES_PER_ROW = 200;

    const ids: string[] = [];
    for (let i = 0; i < ROWS; i++) {
      ids.push(await e.insert("tasks", { title: `row ${i}`, done: false, count: 0 }));
    }
    for (let w = 0; w < WRITES_PER_ROW; w++) {
      for (const id of ids) await e.update("tasks", id, { count: w });
    }

    const totalWrites = ROWS * 3 + ROWS * WRITES_PER_ROW; // 10150 ops
    expect(await e.opCount()).toBe(totalWrites);

    const before = await e.dump();
    const stats = await e.compact();

    // after compaction: exactly one op per live cell (3 columns × 50 rows)
    expect(await e.opCount()).toBe(ROWS * 3);
    expect(stats.removed).toBe(totalWrites - ROWS * 3);
    expect(await e.dump()).toEqual(before);

    // and it stays bounded across another write burst
    for (let w = 0; w < 50; w++) {
      for (const id of ids) await e.update("tasks", id, { count: 1000 + w });
    }
    await e.compact();
    expect(await e.opCount()).toBe(ROWS * 3);
  }, 60_000);
});
