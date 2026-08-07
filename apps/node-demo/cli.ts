/**
 * Node demo: an always-on peer backed by a real SQLite file.
 *
 * Run it alongside the browser demos and it joins the same space as a normal
 * replica — no special server role. Everything it syncs lands in tasks.db,
 * which you can open with any SQLite client while this is running.
 *
 *   node --experimental-strip-types cli.ts <space> <signaling-url>
 *   sqlite3 tasks.db "SELECT * FROM cells;"
 */

import Database from "better-sqlite3";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { WebSocket } from "ws";
import { SyncEngine, Replicator, generateDeviceId } from "@tangentfeed/core";
import { SqliteAdapter, betterSqliteDriver } from "@tangentfeed/adapter-sqlite";
import { WebRTCTransport } from "@tangentfeed/transport-webrtc";
import { createInterface } from "node:readline/promises";

const space = process.argv[2] ?? "demo";
const signaling = process.argv[3] ?? "ws://localhost:8787";
const file = process.env.DB ?? "tasks.db";

const storage = SqliteAdapter.open(betterSqliteDriver(new Database(file)));
const deviceId = generateDeviceId();
const engine = await SyncEngine.open({ deviceId, storage });

const transport = new WebRTCTransport({
  space,
  deviceId,
  signalingUrl: signaling,
  wrtc: { RTCPeerConnection: RTCPeerConnection as never },
  WebSocketImpl: WebSocket as never,
  rtcConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
  onSignalingState: (s) => console.log(`[signaling] ${s}`),
  onError: (err) => console.error("[transport]", err),
});

const replicator = new Replicator({ engine, transport, space });
await replicator.start();

console.log(`tangentfeed node peer
  space:    ${space}
  device:   ${deviceId}
  database: ${file}
  ops:      ${await engine.opCount()}

commands: list | add <title> | done <n> | rm <n> | compact | peers | quit`);

engine.subscribe((ev) => {
  if (ev.origin === "remote") console.log(`\n[synced] ${ev.ops.length} op(s) received`);
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const line = (await rl.question("> ")).trim();
  const [cmd, ...rest] = line.split(" ");
  const arg = rest.join(" ");
  try {
    if (cmd === "quit" || cmd === "exit") break;
    else if (cmd === "add" && arg) {
      await engine.insert("tasks", { title: arg, done: false });
    } else if (cmd === "list" || cmd === "") {
      const rows = await engine.list("tasks");
      rows.forEach((r, i) => console.log(`  ${i + 1}. [${r["done"] ? "x" : " "}] ${r["title"]}`));
      if (rows.length === 0) console.log("  (empty)");
    } else if (cmd === "done" && arg) {
      const rows = await engine.list("tasks");
      const row = rows[Number(arg) - 1];
      if (row) await engine.update("tasks", row.id, { done: !row["done"] });
    } else if (cmd === "rm" && arg) {
      const rows = await engine.list("tasks");
      const row = rows[Number(arg) - 1];
      if (row) await engine.delete("tasks", row.id);
    } else if (cmd === "compact") {
      console.log(" ", await engine.compact());
    } else if (cmd === "peers") {
      console.log(" ", transport.connectedPeers.join(", ") || "(none)");
    } else console.log("  commands: list | add <title> | done <n> | rm <n> | compact | peers | quit");
  } catch (err) {
    console.error("  error:", err instanceof Error ? err.message : err);
  }
}

rl.close();
replicator.stop();
transport.close();
storage.close();
process.exit(0);
