import { describe, it, expect, afterEach } from "vitest";
import {
  SyncEngine,
  MemoryAdapter,
  Replicator,
  type WireMsg,
} from "@tangentfeed/core";
import { BroadcastTransport } from "../src/index.js";

const T0 = 1_700_000_000_000;
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

let spaceCounter = 0;
function freshSpace(): string {
  return `test-${Date.now()}-${spaceCounter++}`;
}

async function peer(space: string, n: number, skewMs = 0) {
  const engine = await SyncEngine.open({
    storage: new MemoryAdapter(),
    physicalClock: () => T0 + Date.now() % 1000 + skewMs,
  });
  const transport = new BroadcastTransport(space);
  const replicator = new Replicator({ engine, transport, space });
  cleanup.push(() => {
    replicator.stop();
    transport.close();
  });
  return { engine, transport, replicator };
}

async function until(cond: () => Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("condition not met within timeout");
}

async function converged(...engines: SyncEngine[]): Promise<boolean> {
  const dumps = await Promise.all(engines.map((e) => e.dump()));
  const first = JSON.stringify(dumps[0]);
  return dumps.every((d) => JSON.stringify(d) === first);
}

describe("BroadcastTransport + Replicator", () => {
  it("late joiner catches up on existing data via hello → since → ops", async () => {
    const space = freshSpace();
    const a = await peer(space, 1);
    await a.engine.insert("tasks", { title: "pre-existing", done: false });
    await a.replicator.start();

    const b = await peer(space, 2);
    await b.replicator.start();

    await until(async () => Object.keys(await b.engine.dump()).length > 0);
    expect(await b.engine.dump()).toEqual(await a.engine.dump());
  });

  it("live tail: edits propagate both directions while connected", async () => {
    const space = freshSpace();
    const a = await peer(space, 1);
    const b = await peer(space, 2);
    await a.replicator.start();
    await b.replicator.start();

    const id = await a.engine.insert("tasks", { title: "live", done: false });
    await until(async () => (await b.engine.get("tasks", id)) !== undefined);

    await b.engine.update("tasks", id, { done: true });
    await until(async () => (await a.engine.get("tasks", id))?.["done"] === true);

    expect(await converged(a.engine, b.engine)).toBe(true);
  });

  it("peers discover each other (peer sets update)", async () => {
    const space = freshSpace();
    const a = await peer(space, 1);
    const b = await peer(space, 2);
    await a.replicator.start();
    await b.replicator.start();
    await until(async () => a.replicator.peerIds.has(b.engine.deviceId));
    await until(async () => b.replicator.peerIds.has(a.engine.deviceId));
  });

  it("offline edits heal on rejoin (stop → edit both sides → start)", async () => {
    const space = freshSpace();
    const a = await peer(space, 1);
    const b = await peer(space, 2, 5);
    await a.replicator.start();
    await b.replicator.start();
    const id = await a.engine.insert("tasks", { title: "Buy milk", done: false });
    await until(async () => (await b.engine.get("tasks", id)) !== undefined);

    // b goes offline
    b.replicator.stop();
    await a.engine.update("tasks", id, { title: "Buy oat milk" });
    await b.engine.update("tasks", id, { done: true });
    expect(await converged(a.engine, b.engine)).toBe(false);

    // rejoin: fresh replicator over the same engine re-runs hello/since
    const r2 = new Replicator({ engine: b.engine, transport: b.transport, space });
    cleanup.push(() => r2.stop());
    await r2.start();

    await until(async () => converged(a.engine, b.engine));
    const row = await a.engine.get("tasks", id);
    expect(row).toEqual({ id, title: "Buy oat milk", done: true });
  });

  it("three peers on one bus all converge", async () => {
    const space = freshSpace();
    const peers = await Promise.all([1, 2, 3].map((n) => peer(space, n)));
    for (const p of peers) await p.replicator.start();

    await peers[0]!.engine.insert("notes", { text: "from one" });
    await peers[1]!.engine.insert("notes", { text: "from two" });
    await peers[2]!.engine.insert("notes", { text: "from three" });

    await until(async () => {
      const dump = await peers[0]!.engine.dump();
      return Object.keys(dump["notes"] ?? {}).length === 3;
    });
    await until(async () => converged(...peers.map((p) => p.engine)));
  });

  it("does not re-broadcast remote ops (no echo storms on a bus)", async () => {
    const space = freshSpace();
    const a = await peer(space, 1);
    const b = await peer(space, 2);

    const opsMsgsFromB: WireMsg[] = [];
    const tap = new BroadcastTransport(space);
    cleanup.push(() => tap.close());
    tap.onMessage((m) => {
      if (m.t === "ops" && m.from === b.engine.deviceId) opsMsgsFromB.push(m);
    });

    await a.replicator.start();
    await b.replicator.start();
    const id = await a.engine.insert("tasks", { title: "no echo" });
    await until(async () => (await b.engine.get("tasks", id)) !== undefined);
    await new Promise((r) => setTimeout(r, 100)); // grace period for any echo

    // b applied a's op but must never rebroadcast it as its own ops message
    expect(opsMsgsFromB).toEqual([]);
  });
});
