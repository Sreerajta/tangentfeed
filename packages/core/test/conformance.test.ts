import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SyncEngine } from "../src/engine.js";
import { MemoryAdapter } from "../src/storage.js";
import { learnTestKeys } from "./test-keys.js";
import type { Op, Frontier } from "../src/op.js";

const VECTORS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../conformance/merge",
);

interface Vector {
  name: string;
  description: string;
  ops: Op[];
  expectedState: Record<string, Record<string, Record<string, unknown>>>;
  expectedFrontier: Frontier;
}

const vectors: Vector[] = readdirSync(VECTORS_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(VECTORS_DIR, f), "utf8")));

/** Deterministic shuffle so failures are reproducible. */
function shuffled<T>(arr: readonly T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

async function freshEngine(): Promise<SyncEngine> {
  const engine = await SyncEngine.open({
    storage: new MemoryAdapter(),
    // fixed clock near the vectors' era so drift checks pass deterministically
    physicalClock: () => 0x018f6e2b_ffff,
  });
  learnTestKeys(engine);
  return engine;
}

describe("conformance vectors (merge)", () => {
  it("found vectors to run", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(4);
  });

  for (const v of vectors) {
    describe(v.name, () => {
      const orderings: [string, Op[]][] = [
        ["as given", v.ops],
        ["reversed", [...v.ops].reverse()],
        ["shuffled(1)", shuffled(v.ops, 1)],
        ["shuffled(42)", shuffled(v.ops, 42)],
        ["with duplicates, shuffled(7)", shuffled([...v.ops, ...v.ops], 7)],
        [
          "one op at a time, shuffled(99)",
          shuffled(v.ops, 99), // applied individually below
        ],
      ];

      for (const [label, ops] of orderings) {
        it(`converges: ${label}`, async () => {
          const engine = await freshEngine();
          if (label.startsWith("one op")) {
            for (const op of ops) await engine.applyRemoteOps([op]);
          } else {
            await engine.applyRemoteOps(ops);
          }
          expect(await engine.dump()).toEqual(v.expectedState);
          expect(await engine.frontier()).toEqual(v.expectedFrontier);
        });
      }
    });
  }
});
