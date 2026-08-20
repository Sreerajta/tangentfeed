/**
 * Manual pairing end-to-end: the full human-carried handshake
 * (createOffer → acceptOffer → acceptAnswer) over real DataChannels,
 * then actual replication through the paired channel. No server anywhere.
 */

import { describe, it, expect, afterAll, afterEach } from "vitest";
import * as ndc from "node-datachannel";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { SyncEngine, MemoryAdapter, Replicator } from "@tangentfeed/core";
import { ManualPairTransport, decodeBlob } from "../src/manual.js";

const T0 = 1_700_000_000_000;
const wrtc = { RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection };

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});
afterAll(() => ndc.cleanup());

async function device(n: number) {
  const engine = await SyncEngine.open({
    storage: new MemoryAdapter(),
    physicalClock: () => T0 + (Date.now() % 100_000),
  });
  const transport = new ManualPairTransport({ deviceId: engine.deviceId, wrtc });
  cleanup.push(() => transport.close());
  return { engine, transport };
}

async function until(cond: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met within timeout");
}

/** The human: carries blobs between devices and wires the replicators. */
async function pair(a: Awaited<ReturnType<typeof device>>, b: Awaited<ReturnType<typeof device>>) {
  const offer = await a.transport.createOffer(); // A shows QR
  const answer = await b.transport.acceptOffer(offer); // B scans, shows QR back
  await a.transport.acceptAnswer(answer); // A scans

  const space = a.transport.space!;
  expect(b.transport.space).toBe(space); // answerer adopted the minted space

  const ra = new Replicator({ engine: a.engine, transport: a.transport, space });
  const rb = new Replicator({ engine: b.engine, transport: b.transport, space });
  cleanup.push(() => {
    ra.stop();
    rb.stop();
  });
  await ra.start();
  await rb.start();
  await until(() => a.transport.state === "connected" && b.transport.state === "connected");
}

describe("manual pairing (zero-server)", () => {
  it("pairs via offer/answer blobs and syncs live edits both ways", async () => {
    const a = await device(1);
    const b = await device(2);
    await pair(a, b);

    const id = await a.engine.insert("tasks", { title: "paired by hand", done: false });
    await until(async () => (await b.engine.get("tasks", id)) !== undefined);

    await b.engine.update("tasks", id, { done: true });
    await until(async () => (await a.engine.get("tasks", id))?.["done"] === true);
  }, 20_000);

  it("pre-existing data flows to the newly paired device (hello on channel open)", async () => {
    const a = await device(1);
    const b = await device(2);
    await a.engine.insert("recipes", { name: "sambar" });
    await a.engine.insert("recipes", { name: "avial" });
    await pair(a, b);

    await until(async () => {
      const dump = await b.engine.dump();
      return Object.keys(dump["recipes"] ?? {}).length === 2;
    });
    expect(await b.engine.dump()).toEqual(await a.engine.dump());
  }, 20_000);

  it("blobs are QR-safe (base64url, no padding/newlines) and self-describing", async () => {
    const a = await device(1);
    const offer = await a.transport.createOffer();
    expect(offer).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = decodeBlob(offer);
    expect(decoded.kind).toBe("offer");
    expect(decoded.device).toBe(a.engine.deviceId);
    expect(decoded.space).toMatch(/^manual-/);
    expect(String(decoded.sdp.sdp)).toContain("candidate"); // non-trickle: inline ICE
  }, 15_000);

  it("clear errors: offer pasted where answer expected, garbage input, wrong order", async () => {
    const a = await device(1);
    const b = await device(2);
    const offer = await a.transport.createOffer();

    await expect(a.transport.acceptAnswer(offer)).rejects.toThrow(/expected an ANSWER/);
    expect(() => decodeBlob("definitely-not-a-blob")).toThrow(/not a valid pairing blob/);

    const fresh = await device(3);
    const answer = await b.transport.acceptOffer(offer);
    await expect(fresh.transport.acceptAnswer(answer)).rejects.toThrow(/no pending offer/);
  }, 15_000);
});
