import { describe, it, expect } from "vitest";
import { SyncEngine, syncOnce } from "../src/engine.js";
import { MemoryAdapter } from "../src/storage.js";
import { BadOpError, type Op } from "../src/op.js";
import { ClockDriftError } from "../src/hlc.js";

const T0 = 1_700_000_000_000;

function device(n: number): string {
  return n.toString(16).padStart(16, "0");
}

async function engine(n: number, clock?: () => number): Promise<SyncEngine> {
  return SyncEngine.open({
    deviceId: device(n),
    storage: new MemoryAdapter(),
    physicalClock: clock ?? (() => T0),
  });
}

describe("local API", () => {
  it("insert / get / update / list round-trip", async () => {
    const e = await engine(1);
    const id = await e.insert("tasks", { title: "one", done: false });
    expect(await e.get("tasks", id)).toEqual({ id, title: "one", done: false });

    await e.update("tasks", id, { done: true });
    expect(await e.get("tasks", id)).toEqual({ id, title: "one", done: true });

    const id2 = await e.insert("tasks", { title: "two" });
    const rows = await e.list("tasks");
    expect(rows.map((r) => r["title"])).toEqual(["one", "two"]);
    expect(id < id2).toBe(true); // ULIDs sort by insertion
  });

  it("delete tombstones the row; get and list hide it", async () => {
    const e = await engine(1);
    const id = await e.insert("tasks", { title: "doomed" });
    await e.delete("tasks", id);
    expect(await e.get("tasks", id)).toBeUndefined();
    expect(await e.list("tasks")).toEqual([]);
  });

  it("null value clears a cell", async () => {
    const e = await engine(1);
    const id = await e.insert("tasks", { title: "x", note: "temp" });
    await e.update("tasks", id, { note: null });
    expect(await e.get("tasks", id)).toEqual({ id, title: "x" });
  });

  it("rejects invalid table and column names before they enter the log", async () => {
    const e = await engine(1);
    await expect(e.insert("bad table!", { a: 1 })).rejects.toThrow(BadOpError);
    await expect(e.insert("ok", { "bad col!": 1 })).rejects.toThrow(BadOpError);
    expect(await e.opsSince({})).toEqual([]); // nothing leaked into the log
  });

  it("subscribers fire with changed rows + ops + origin, and unsubscribe works", async () => {
    const e = await engine(1);
    const seen: string[] = [];
    const unsub = e.subscribe((ev) => {
      expect(ev.origin).toBe("local");
      expect(ev.ops.length).toBeGreaterThan(0);
      seen.push(...ev.changes.map((c) => `${c.table}/${c.row}`));
    });
    const id = await e.insert("tasks", { title: "hi" });
    expect(seen).toEqual([`tasks/${id}`]);
    unsub();
    await e.update("tasks", id, { title: "bye" });
    expect(seen).toHaveLength(1);
  });
});

describe("applyRemoteOps", () => {
  it("is idempotent: duplicates return 0 and change nothing", async () => {
    const a = await engine(1);
    const b = await engine(2);
    await a.insert("tasks", { title: "from a" });
    const ops = await a.opsSince({});
    expect(await b.applyRemoteOps(ops)).toBe(ops.length);
    expect(await b.applyRemoteOps(ops)).toBe(0);
    expect(await b.dump()).toEqual(await a.dump());
  });

  it("atomically rejects a batch containing any bad op", async () => {
    const a = await engine(1);
    const b = await engine(2);
    await a.insert("tasks", { title: "good" });
    const good = await a.opsSince({});
    const bad = { ...good[0]!, table: "no spaces allowed" };
    await expect(b.applyRemoteOps([...good, bad])).rejects.toThrow(BadOpError);
    expect(await b.dump()).toEqual({}); // nothing applied
  });

  it("rejects ops beyond MAX_DRIFT and applies nothing (§4.5)", async () => {
    const a = await engine(1, () => T0 + 10 * 60_000); // clock 10 min ahead
    const b = await engine(2, () => T0);
    await a.insert("tasks", { title: "from the future" });
    const ops = await a.opsSince({});
    await expect(b.applyRemoteOps(ops)).rejects.toThrow(ClockDriftError);
    expect(await b.dump()).toEqual({});
  });

  it("causality: a write made after syncing wins LWW even on a lagging clock", async () => {
    let tA = T0 + 60_000; // A's clock runs a minute fast
    let tB = T0; //          B's clock is behind
    const a = await engine(1, () => tA);
    const b = await engine(2, () => tB);

    const id = await a.insert("tasks", { title: "A's version" });
    await syncOnce(a, b);
    // B saw A's op; B's next write must beat it despite the lagging wall clock
    await b.update("tasks", id, { title: "B's correction" });
    await syncOnce(a, b);

    expect((await a.get("tasks", id))!["title"]).toBe("B's correction");
    expect((await b.get("tasks", id))!["title"]).toBe("B's correction");
  });

  it("persists clock state so a restart cannot reissue timestamps", async () => {
    const storage = new MemoryAdapter();
    const e1 = await SyncEngine.open({
      deviceId: device(1),
      storage,
      physicalClock: () => T0,
    });
    await e1.insert("t", { a: 1 });
    const before = (await e1.opsSince({})).map((o) => o.id);

    // "restart" on the same storage, same frozen wall clock
    const e2 = await SyncEngine.open({
      deviceId: device(1),
      storage,
      physicalClock: () => T0,
    });
    await e2.insert("t", { a: 2 });
    const after = (await e2.opsSince({})).map((o) => o.id);
    expect(new Set(after).size).toBe(after.length); // all ids unique
    expect(after.slice(0, before.length)).toEqual(before);
  });
});

describe("two-engine sync scenarios", () => {
  it("offline concurrent edits to different cells both survive", async () => {
    const a = await engine(1, () => T0);
    const b = await engine(2, () => T0 + 1);
    const id = await a.insert("tasks", { title: "Buy milk", done: false });
    await syncOnce(a, b);

    // offline: A retitles, B completes
    await a.update("tasks", id, { title: "Buy oat milk" });
    await b.update("tasks", id, { done: true });
    await syncOnce(a, b);

    const expected = { id, title: "Buy oat milk", done: true };
    expect(await a.get("tasks", id)).toEqual(expected);
    expect(await b.get("tasks", id)).toEqual(expected);
  });

  it("delete vs concurrent edit: tombstone hides the row on both peers", async () => {
    const a = await engine(1, () => T0);
    const b = await engine(2, () => T0);
    const id = await a.insert("tasks", { title: "contested" });
    await syncOnce(a, b);

    await a.delete("tasks", id);
    await b.update("tasks", id, { title: "still here?" });
    await syncOnce(a, b);

    expect(await a.get("tasks", id)).toBeUndefined();
    expect(await b.get("tasks", id)).toBeUndefined();
    expect(await a.dump()).toEqual(await b.dump());
  });
});
