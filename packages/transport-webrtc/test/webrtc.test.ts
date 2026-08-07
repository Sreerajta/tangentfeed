/**
 * Real end-to-end: actual DataChannels (node-datachannel) through the actual
 * signaling server. No mocks anywhere. If these pass, the only untested
 * variable in a browser is the browser itself.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as ndc from "node-datachannel";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { WebSocket } from "ws";
import { SyncEngine, MemoryAdapter, Replicator } from "@tangentfeed/core";
import { createSignalingServer, type SignalingServer } from "@tangentfeed/signaling-server";
import { WebRTCTransport } from "../src/index.js";

const T0 = 1_700_000_000_000;

let server: SignalingServer;
let cleanup: (() => void)[] = [];

beforeAll(async () => {
  server = await createSignalingServer({ port: 0 });
});
afterAll(async () => {
  await server.close();
  ndc.cleanup();
});
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

let spaceCounter = 0;
const freshSpace = () => `rtc-${Date.now()}-${spaceCounter++}`;

async function peer(space: string, n: number) {
  const engine = await SyncEngine.open({
    deviceId: n.toString(16).padStart(16, "0"),
    storage: new MemoryAdapter(),
    physicalClock: () => T0 + (Date.now() % 100_000),
  });
  const transport = new WebRTCTransport({
    space,
    deviceId: engine.deviceId,
    signalingUrl: `ws://127.0.0.1:${server.port}`,
    wrtc: { RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection },
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  const replicator = new Replicator({ engine, transport, space });
  await replicator.start();
  cleanup.push(() => {
    replicator.stop();
    transport.close();
  });
  return { engine, transport, replicator };
}

async function until(cond: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met within timeout");
}

describe("WebRTC transport end-to-end", () => {
  it("two peers connect over real DataChannels and exchange live edits", async () => {
    const space = freshSpace();
    const a = await peer(space, 1);
    const b = await peer(space, 2);

    await until(() => a.transport.connectedPeers.length === 1);
    await until(() => b.transport.connectedPeers.length === 1);

    const id = await a.engine.insert("tasks", { title: "over webrtc", done: false });
    await until(async () => (await b.engine.get("tasks", id)) !== undefined);

    await b.engine.update("tasks", id, { done: true });
    await until(async () => (await a.engine.get("tasks", id))?.["done"] === true);
  }, 20_000);

  it("late joiner receives full pre-existing state (hello on channel open)", async () => {
    const space = freshSpace();
    const a = await peer(space, 1);
    await a.engine.insert("docs", { title: "written before b existed" });
    await a.engine.insert("docs", { title: "also before" });

    const b = await peer(space, 2);
    await until(async () => {
      const dump = await b.engine.dump();
      return Object.keys(dump["docs"] ?? {}).length === 2;
    });
    expect(await b.engine.dump()).toEqual(await a.engine.dump());
  }, 20_000);

  it("three peers form a mesh and converge", async () => {
    const space = freshSpace();
    const peers = await Promise.all([1, 2, 3].map((n) => peer(space, n)));
    for (const p of peers) {
      await until(() => p.transport.connectedPeers.length === 2);
    }

    await peers[0]!.engine.insert("notes", { text: "one" });
    await peers[1]!.engine.insert("notes", { text: "two" });
    await peers[2]!.engine.insert("notes", { text: "three" });

    await until(async () => {
      const dumps = await Promise.all(peers.map((p) => p.engine.dump()));
      return dumps.every(
        (d) =>
          Object.keys(d["notes"] ?? {}).length === 3 &&
          JSON.stringify(d) === JSON.stringify(dumps[0]),
      );
    });
  }, 30_000);

  it("offline edits on both sides converge after the offline peer returns", async () => {
    const space = freshSpace();
    const a = await peer(space, 1);
    const b = await peer(space, 2);
    await until(() => a.transport.connectedPeers.length === 1);

    const id = await a.engine.insert("tasks", { title: "Buy milk", done: false });
    await until(async () => (await b.engine.get("tasks", id)) !== undefined);

    // b drops off entirely
    b.replicator.stop();
    b.transport.close();
    await until(() => a.transport.connectedPeers.length === 0);

    await a.engine.update("tasks", id, { title: "Buy oat milk" });
    await b.engine.update("tasks", id, { done: true });

    // b returns with a fresh transport over the SAME engine (same replica)
    const t2 = new WebRTCTransport({
      space,
      deviceId: b.engine.deviceId,
      signalingUrl: `ws://127.0.0.1:${server.port}`,
      wrtc: { RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection },
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    const r2 = new Replicator({ engine: b.engine, transport: t2, space });
    await r2.start();
    cleanup.push(() => {
      r2.stop();
      t2.close();
    });

    await until(async () => {
      const row = await a.engine.get("tasks", id);
      return row?.["title"] === "Buy oat milk" && row?.["done"] === true;
    });
    expect(await b.engine.get("tasks", id)).toEqual({
      id,
      title: "Buy oat milk",
      done: true,
    });
  }, 30_000);

  it("duplicate deviceId → first holder gets terminal 'conflict', no eviction duel", async () => {
    const space = freshSpace();
    const states1: string[] = [];
    const states2: string[] = [];
    const mk = (states: string[]) =>
      new WebRTCTransport({
        space,
        deviceId: "dddddddddddddddd", // same id on purpose
        signalingUrl: `ws://127.0.0.1:${server.port}`,
        wrtc: { RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection },
        WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
        onSignalingState: (s) => states.push(s),
      });
    const t1 = mk(states1);
    cleanup.push(() => t1.close());
    await until(() => states1.includes("connected"));

    const t2 = mk(states2);
    cleanup.push(() => t2.close());
    await until(() => states2.includes("connected"));

    // t1 must be evicted with a TERMINAL conflict — and must not reconnect
    // (a reconnect would evict t2 and start the duel)
    await until(() => states1.includes("conflict"));
    await new Promise((r) => setTimeout(r, 800)); // longer than initial backoff
    expect(states2).not.toContain("conflict"); // t2 keeps the identity
    expect(states1.filter((s) => s === "connecting").length).toBe(1); // no retry after conflict
  }, 15_000);

  it("signaling server relays blindly and reports presence correctly", async () => {
    // direct signaling-protocol check, no WebRTC: two raw ws clients
    const ws1 = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${server.port}`);
    cleanup.push(() => {
      ws1.close();
      ws2.close();
    });
    const inbox1: Record<string, unknown>[] = [];
    const inbox2: Record<string, unknown>[] = [];
    ws1.on("message", (d) => inbox1.push(JSON.parse(d.toString())));
    ws2.on("message", (d) => inbox2.push(JSON.parse(d.toString())));
    await until(() => ws1.readyState === 1 && ws2.readyState === 1);

    ws1.send(JSON.stringify({ t: "join", space: "sig-test", device: "dev1" }));
    await until(() => inbox1.some((m) => m["t"] === "peers"));
    expect(inbox1.find((m) => m["t"] === "peers")?.["devices"]).toEqual([]);

    ws2.send(JSON.stringify({ t: "join", space: "sig-test", device: "dev2" }));
    await until(() => inbox2.some((m) => m["t"] === "peers"));
    expect(inbox2.find((m) => m["t"] === "peers")?.["devices"]).toEqual(["dev1"]);
    await until(() => inbox1.some((m) => m["t"] === "peer-joined"));

    ws1.send(JSON.stringify({ t: "signal", to: "dev2", data: { opaque: "blob" } }));
    await until(() => inbox2.some((m) => m["t"] === "signal"));
    const sig = inbox2.find((m) => m["t"] === "signal")!;
    expect(sig["from"]).toBe("dev1");
    expect(sig["data"]).toEqual({ opaque: "blob" });

    ws2.close();
    await until(() => inbox1.some((m) => m["t"] === "peer-left"));
  }, 15_000);
});
