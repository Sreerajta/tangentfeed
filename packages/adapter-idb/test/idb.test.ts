import "fake-indexeddb/auto"; // installs IDBKeyRange & friends as globals
import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SyncEngine,
  MemoryAdapter,
  syncOnce,
  type Op,
  type Frontier,
} from "@tangentfeed/core";
import { IdbAdapter } from "../src/index.js";

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

let factory: IDBFactory;
beforeEach(() => {
  factory = new IDBFactory(); // pristine IndexedDB universe per test
});

async function idbEngine(space: string, deviceHex = "1", clock?: () => number) {
  const storage = await IdbAdapter.open(space, factory);
  const engine = await SyncEngine.open({
    deviceId: deviceHex.padStart(16, "0"),
    storage,
    physicalClock: clock ?? (() => 0x018f6e2b_ffff),
  });
  return { engine, storage };
}

describe("conformance vectors run identically on IdbAdapter", () => {
  for (const v of vectors) {
    it(v.name, async () => {
      const { engine } = await idbEngine(`vec-${v.name}`);
      await engine.applyRemoteOps([...v.ops].reverse()); // hostile order
      expect(await engine.dump()).toEqual(v.expectedState);
      expect(await engine.frontier()).toEqual(v.expectedFrontier);
    });
  }
});

describe("persistence", () => {
  it("state, frontier, and ops survive close + reopen", async () => {
    const { engine: e1, storage: s1 } = await idbEngine("persist");
    const id = await e1.insert("tasks", { title: "durable", done: false });
    await e1.update("tasks", id, { done: true });
    const dump1 = await e1.dump();
    const frontier1 = await e1.frontier();
    const ops1 = await e1.opsSince({});
    s1.close();

    const { engine: e2 } = await idbEngine("persist");
    expect(await e2.dump()).toEqual(dump1);
    expect(await e2.frontier()).toEqual(frontier1);
    expect(await e2.opsSince({})).toEqual(ops1);
  });

  it("clock restarts safely: no reissued timestamps after reopen (frozen wall clock)", async () => {
    const { engine: e1, storage: s1 } = await idbEngine("clock", "1", () => T0);
    await e1.insert("t", { a: 1 });
    const idsBefore = (await e1.opsSince({})).map((o) => o.id);
    s1.close();

    const { engine: e2 } = await idbEngine("clock", "1", () => T0);
    await e2.insert("t", { a: 2 });
    const idsAfter = (await e2.opsSince({})).map((o) => o.id);
    expect(new Set(idsAfter).size).toBe(idsAfter.length);
    expect(idsAfter.slice(0, idsBefore.length)).toEqual(idsBefore);
  });

  it("destroy() wipes a space", async () => {
    const { engine: e1, storage: s1 } = await idbEngine("wipe");
    await e1.insert("t", { a: 1 });
    s1.close();
    await IdbAdapter.destroy("wipe", factory);
    const { engine: e2 } = await idbEngine("wipe");
    expect(await e2.dump()).toEqual({});
  });

  it("spaces are isolated from each other", async () => {
    const a = await idbEngine("space-a");
    const b = await idbEngine("space-b");
    await a.engine.insert("t", { who: "a" });
    expect(await b.engine.dump()).toEqual({});
  });
});

describe("interop", () => {
  it("IdbAdapter engine syncs with MemoryAdapter engine (adapter-agnostic protocol)", async () => {
    const { engine: idb } = await idbEngine("interop", "1", () => T0);
    const mem = await SyncEngine.open({
      deviceId: "2".padStart(16, "0"),
      storage: new MemoryAdapter(),
      physicalClock: () => T0 + 1,
    });

    const id = await idb.insert("tasks", { title: "Buy milk", done: false });
    await syncOnce(idb, mem);
    await idb.update("tasks", id, { title: "Buy oat milk" }); // offline edits
    await mem.update("tasks", id, { done: true });
    await syncOnce(idb, mem);

    const want = { id, title: "Buy oat milk", done: true };
    expect(await idb.get("tasks", id)).toEqual(want);
    expect(await mem.get("tasks", id)).toEqual(want);
    expect(await idb.dump()).toEqual(await mem.dump());
  });

  it("subscriber fires on remote application (UI wiring works)", async () => {
    const { engine: idb } = await idbEngine("notify", "1", () => T0);
    const mem = await SyncEngine.open({
      deviceId: "2".padStart(16, "0"),
      storage: new MemoryAdapter(),
      physicalClock: () => T0,
    });
    await mem.insert("tasks", { title: "incoming" });
    const changes: string[] = [];
    idb.subscribe((ev) => {
      expect(ev.origin).toBe("remote");
      changes.push(...ev.changes.map((c) => c.table));
    });
    await idb.applyRemoteOps(await mem.opsSince({}));
    expect(changes).toEqual(["tasks"]);
  });
});
