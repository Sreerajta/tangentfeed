/**
 * Public API surface. These tests use only what a consumer imports from
 * "tangentfeed" — no reaching into internals — so they double as executable docs
 * and as a guard against breaking the published shape.
 */

import { describe, it, expect, afterEach } from "vitest";
import { openSpace, broadcast, type SyncedSpace } from "../src/index.js";
import { MemoryAdapter } from "@tangentfeed/core";

let open: SyncedSpace[] = [];
afterEach(async () => {
  for (const db of open) await db.close();
  open = [];
});

let n = 0;
const freshSpace = () => `api-${Date.now()}-${n++}`;

async function space(name: string, opts: Partial<Parameters<typeof openSpace>[0]> = {}) {
  const db = await openSpace({ space: name, storage: "memory", ...opts });
  open.push(db);
  return db;
}

describe("openSpace", () => {
  it("works with no transports at all (purely local database)", async () => {
    const db = await space(freshSpace());
    const id = await db.insert("tasks", { title: "local only", done: false });
    expect(await db.get("tasks", id)).toEqual({ id, title: "local only", done: false });
    expect(await db.list("tasks")).toHaveLength(1);
    await db.update("tasks", id, { done: true });
    expect((await db.get("tasks", id))!["done"]).toBe(true);
    await db.delete("tasks", id);
    expect(await db.list("tasks")).toEqual([]);
  });

  it("derives its deviceId from a keypair it persists", async () => {
    // There is no deviceId option any more: an identity cannot be asserted,
    // only proved by a key (§4.3). It is 32 hex characters now, not 16.
    const auto = await space(freshSpace());
    expect(auto.deviceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("keeps the same identity when the same storage is reopened", async () => {
    const storage = new MemoryAdapter();
    const first = await openSpace({ space: "identity", storage });
    const second = await openSpace({ space: "identity", storage });
    expect(second.deviceId).toBe(first.deviceId);
    await first.close();
    await second.close();
  });

  it("syncs two spaces over the broadcast transport", async () => {
    const name = freshSpace();
    const a = await space(name, { transports: [broadcast()] });
    const b = await space(name, { transports: [broadcast()] });

    const id = await a.insert("tasks", { title: "shared", done: false });
    await waitFor(async () => (await b.get("tasks", id)) !== undefined);

    await b.update("tasks", id, { done: true });
    await waitFor(async () => (await a.get("tasks", id))?.["done"] === true);

    await waitFor(() => a.peers().includes(b.deviceId));
  });

  it("encrypts values end-to-end when given a passphrase", async () => {
    const name = freshSpace();
    const a = await space(name, {
      transports: [broadcast()],
      encryption: { passphrase: "correct horse battery staple" },
    });
    const b = await space(name, {
      transports: [broadcast()],
      encryption: { passphrase: "correct horse battery staple" },
    });

    const id = await a.insert("notes", { text: "sensitive material" });
    await waitFor(async () => (await b.get("notes", id)) !== undefined);
    expect((await b.get("notes", id))!["text"]).toBe("sensitive material");

    // what a relay would see
    const wire = JSON.stringify(await a.engine.opsSince({}));
    expect(wire).not.toContain("sensitive material");
    expect(wire).toContain("e1:");
  }, 30_000);

  it("notifies subscribers with origin, and unsubscribes cleanly", async () => {
    const db = await space(freshSpace());
    const origins: string[] = [];
    const unsub = db.subscribe((ev) => origins.push(ev.origin));
    await db.insert("tasks", { title: "x" });
    expect(origins).toEqual(["local"]);
    unsub();
    await db.insert("tasks", { title: "y" });
    expect(origins).toEqual(["local"]);
  });

  it("exposes compaction with its safety reporting", async () => {
    const db = await space(freshSpace());
    const id = await db.insert("tasks", { title: "v1" });
    await db.update("tasks", id, { title: "v2" });
    await db.update("tasks", id, { title: "v3" });

    const dry = await db.compact({ dryRun: true });
    expect(dry.removed).toBe(2);
    const real = await db.compact();
    expect(real.removed).toBe(2);
    expect(real.blockedBy).toEqual([]);
    expect((await db.get("tasks", id))!["title"]).toBe("v3");
  });

  it("close() is idempotent and stops replication", async () => {
    const name = freshSpace();
    const db = await space(name, { transports: [broadcast()] });
    await db.close();
    await db.close(); // must not throw
  });
});

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition not met within timeout");
}
