import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  SyncEngine,
  MemoryAdapter,
  syncOnce,
  type Frontier,
  type Op,
} from "@tangentfeed/core";
import { SqliteAdapter, betterSqliteDriver, nodeSqliteDriver } from "../src/index.js";

const T0 = 1_700_000_000_000;
const VECTORS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../conformance/merge",
);

interface Vector {
  name: string;
  ops: Op[];
  expectedState: Record<string, Record<string, Record<string, unknown>>>;
  expectedFrontier: Frontier;
}

const vectors: Vector[] = readdirSync(VECTORS_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(VECTORS_DIR, f), "utf8")));

const tmpDirs: string[] = [];
const openAdapters: SqliteAdapter[] = [];
afterEach(() => {
  for (const a of openAdapters.splice(0)) {
    try {
      a.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function memoryAdapter(): SqliteAdapter {
  const a = SqliteAdapter.open(betterSqliteDriver(new Database(":memory:")));
  openAdapters.push(a);
  return a;
}

function fileAdapter(path: string): SqliteAdapter {
  const a = SqliteAdapter.open(betterSqliteDriver(new Database(path)));
  openAdapters.push(a);
  return a;
}

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "tangentfeed-sqlite-"));
  tmpDirs.push(dir);
  return join(dir, "space.db");
}

async function engine(storage: SqliteAdapter, n = 1, clock?: () => number) {
  return SyncEngine.open({
    deviceId: n.toString(16).padStart(16, "0"),
    storage,
    physicalClock: clock ?? (() => 0x018f6e2b_ffff),
  });
}

describe("conformance vectors on SQLite", () => {
  for (const v of vectors) {
    it(v.name, async () => {
      const e = await engine(memoryAdapter());
      await e.applyRemoteOps([...v.ops].reverse()); // hostile order
      expect(await e.dump()).toEqual(v.expectedState);
      expect(await e.frontier()).toEqual(v.expectedFrontier);
    });
  }
});

describe("drivers", () => {
  it("works with better-sqlite3", async () => {
    const e = await engine(memoryAdapter());
    const id = await e.insert("tasks", { title: "bs3", done: false });
    expect(await e.get("tasks", id)).toEqual({ id, title: "bs3", done: false });
  });

  it("works with node:sqlite (same adapter, different driver)", async () => {
    // dynamic import: node:sqlite is Node 22+ and unavailable in some runtimes
    let DatabaseSync: new (p: string) => never;
    try {
      ({ DatabaseSync } = (await import(/* @vite-ignore */ "node:" + "sqlite")) as {
        DatabaseSync: new (p: string) => never;
      });
    } catch {
      return; // driver not available here; better-sqlite3 path already covered
    }
    const adapter = SqliteAdapter.open(nodeSqliteDriver(new DatabaseSync(":memory:")));
    openAdapters.push(adapter);
    const e = await engine(adapter);
    const id = await e.insert("tasks", { title: "node:sqlite", done: true });
    expect(await e.get("tasks", id)).toEqual({ id, title: "node:sqlite", done: true });
    await e.delete("tasks", id);
    expect(await e.get("tasks", id)).toBeUndefined();
  });
});

describe("persistence on disk", () => {
  it("survives close and reopen of the database file", async () => {
    const path = tmpFile();
    const a1 = fileAdapter(path);
    const e1 = await engine(a1, 1, () => T0);
    const id = await e1.insert("tasks", { title: "durable", done: false });
    await e1.update("tasks", id, { done: true });
    const dump = await e1.dump();
    const frontier = await e1.frontier();
    const ops = await e1.opsSince({});
    a1.close();

    const a2 = fileAdapter(path);
    const e2 = await engine(a2, 1, () => T0);
    expect(await e2.dump()).toEqual(dump);
    expect(await e2.frontier()).toEqual(frontier);
    expect(await e2.opsSince({})).toEqual(ops);
  });

  it("clock state survives restart: no reissued timestamps on a frozen wall clock", async () => {
    const path = tmpFile();
    const a1 = fileAdapter(path);
    const e1 = await engine(a1, 1, () => T0);
    await e1.insert("t", { a: 1 });
    const before = (await e1.opsSince({})).map((o) => o.id);
    a1.close();

    const a2 = fileAdapter(path);
    const e2 = await engine(a2, 1, () => T0);
    await e2.insert("t", { a: 2 });
    const after = (await e2.opsSince({})).map((o) => o.id);
    expect(new Set(after).size).toBe(after.length);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it("stores ops as real, queryable rows", async () => {
    const path = tmpFile();
    const adapter = fileAdapter(path);
    const e = await engine(adapter, 1, () => T0);
    await e.insert("tasks", { title: "queryable", done: false });
    adapter.close();

    // open the file with a plain SQLite client: no tangentfeed involved
    const raw = new Database(path, { readonly: true });
    const rows = raw
      .prepare(`SELECT table_name, column_name, value FROM ops ORDER BY id`)
      .all() as { table_name: string; column_name: string; value: string }[];
    expect(rows.map((r) => r.column_name).sort()).toEqual(["done", "title"]);
    expect(rows.find((r) => r.column_name === "title")!.value).toBe('"queryable"');
    const cells = raw.prepare(`SELECT COUNT(*) AS n FROM cells`).get() as { n: number };
    expect(cells.n).toBe(2);
    raw.close();
  });
});

describe("interop and correctness", () => {
  it("SQLite engine syncs with an in-memory engine and converges", async () => {
    const sq = await engine(memoryAdapter(), 1, () => T0);
    const mem = await SyncEngine.open({
      deviceId: "2".padStart(16, "0"),
      storage: new MemoryAdapter(),
      physicalClock: () => T0 + 1,
    });

    const id = await sq.insert("tasks", { title: "Buy milk", done: false });
    await syncOnce(sq, mem);
    await sq.update("tasks", id, { title: "Buy oat milk" }); // offline edits
    await mem.update("tasks", id, { done: true });
    await syncOnce(sq, mem);

    const want = { id, title: "Buy oat milk", done: true };
    expect(await sq.get("tasks", id)).toEqual(want);
    expect(await mem.get("tasks", id)).toEqual(want);
    expect(await sq.dump()).toEqual(await mem.dump());
  });

  it("opsSince returns correct results with a partial frontier", async () => {
    const a = await engine(memoryAdapter(), 1, () => T0);
    const b = await SyncEngine.open({
      deviceId: "2".padStart(16, "0"),
      storage: new MemoryAdapter(),
      physicalClock: () => T0 + 5,
    });
    await a.insert("t", { x: 1 });
    await syncOnce(a, b);
    await b.insert("t", { y: 2 }); // op from a device a knows
    await a.applyRemoteOps(await b.opsSince(await a.frontier()));
    await a.insert("t", { z: 3 });

    // frontier mentioning only device 1: must still return device 2's ops
    const partial: Frontier = { [a.deviceId]: (await a.frontier())[a.deviceId]! };
    const missing = await a.opsSince(partial);
    expect(missing.every((o) => o.device === b.deviceId)).toBe(true);
    expect(missing.length).toBe(1);

    // empty frontier returns everything, in hlc order
    const all = await a.opsSince({});
    expect(all.length).toBe(3);
    expect([...all].sort((x, y) => (x.hlc < y.hlc ? -1 : 1))).toEqual(all);
  });

  it("applyBatch is atomic: a failure leaves no partial write", async () => {
    const adapter = memoryAdapter();
    const e = await engine(adapter, 1, () => T0);
    await e.insert("tasks", { title: "before" });
    const countBefore = await adapter.opCount();
    const frontierBefore = await adapter.getFrontier();

    // The second op carries a value the driver cannot bind (a function), so
    // the statement throws midway through the transaction. Note that plain
    // constraint violations would NOT surface here: op inserts use
    // INSERT OR IGNORE for idempotent dedupe (§3), which by design swallows
    // duplicate-key conflicts.
    const good = await e.opsSince({});
    const ok: Op = { ...good[0]!, id: "018f6e2a9999-0000-0000000000000001" };
    const bad = {
      ...ok,
      id: "018f6e2a8888-0000-0000000000000001",
      hlc: () => "not bindable",
    } as unknown as Op;

    await expect(
      adapter.applyBatch({
        ops: [ok, bad],
        winners: new Map(),
        frontier: { deadbeefdeadbeef: "x" },
        clock: { millis: 999, counter: 9 },
      }),
    ).rejects.toThrow();

    expect(await adapter.opCount()).toBe(countBefore); // the good op rolled back too
    expect(await adapter.getFrontier()).toEqual(frontierBefore); // and the meta write
  });

  it("compaction reclaims ops and shrinks the log", async () => {
    const e = await engine(memoryAdapter(), 1, () => T0);
    const id = await e.insert("tasks", { title: "v1" });
    for (const t of ["v2", "v3", "v4"]) await e.update("tasks", id, { title: t });
    expect(await e.opCount()).toBe(4);

    const before = await e.dump();
    const stats = await e.compact();
    expect(stats.removed).toBe(3);
    expect(await e.opCount()).toBe(1);
    expect(await e.dump()).toEqual(before);
  });
});
