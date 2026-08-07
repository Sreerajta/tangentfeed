/**
 * tangentfeed — offline-first, peer-to-peer data sync.
 *
 * This package is the batteries-included entry point. It assembles the pieces
 * (engine, storage adapter, transports, optional encryption) that the
 * @tangentfeed/* packages provide individually, so the common case is one call:
 *
 *   const db = await openSpace({
 *     space: "kitchen-42",
 *     transports: [broadcast(), webrtc({ signaling: "wss://…" })],
 *     encryption: { passphrase: "correct horse battery staple" },
 *   });
 *
 *   await db.insert("tasks", { title: "Buy oat milk", done: false });
 *   db.subscribe(() => render(db.list("tasks")));
 *
 * Everything remains available à la carte: import from @tangentfeed/core to build
 * against the protocol directly with your own storage or transport.
 */

import {
  Replicator,
  SyncEngine,
  generateDeviceId,
  type ChangeEvent,
  type Frontier,
  type Json,
  type RowData,
  type StorageAdapter,
  type Transport,
} from "@tangentfeed/core";
import { IdbAdapter } from "@tangentfeed/adapter-idb";
import { MemoryAdapter } from "@tangentfeed/core";
import { SpaceCipher } from "@tangentfeed/crypto";
import { BroadcastTransport } from "@tangentfeed/transport-broadcast";
import {
  ManualPairTransport,
  WebRTCTransport,
  type ManualPairState,
  type SignalingState,
} from "@tangentfeed/transport-webrtc";

export type TransportFactory = (ctx: {
  space: string;
  deviceId: string;
}) => Transport | Promise<Transport>;

export interface OpenSpaceOptions {
  /** Logical database name; peers only sync within the same space. */
  space: string;
  /**
   * Stable identity for this replica. Defaults to a fresh random id, which is
   * right for ephemeral clients. Persist it yourself (and pass it back) if you
   * want a device to keep its identity across reloads.
   *
   * Note: two live replicas MUST NOT share a deviceId. Beware of copying it
   * into sessionStorage, which browsers duplicate along with the tab.
   */
  deviceId?: string;
  /**
   * "indexeddb" (default in browsers), "memory", or any StorageAdapter.
   *
   * For SQLite, construct the adapter yourself and pass it here — the driver
   * (better-sqlite3, node:sqlite, bun:sqlite) is your choice, and keeping it
   * out of this package means browsers never bundle a native dependency:
   *
   *   import { SqliteAdapter, betterSqliteDriver } from "@tangentfeed/adapter-sqlite";
   *   import Database from "better-sqlite3";
   *
   *   const db = await openSpace({
   *     space: "kitchen-42",
   *     storage: SqliteAdapter.open(betterSqliteDriver(new Database("data.db"))),
   *   });
   */
  storage?: "indexeddb" | "memory" | StorageAdapter;
  /** Zero or more transports. Omit for a purely local database. */
  transports?: TransportFactory[];
  /** End-to-end encryption. Every peer in the space needs the same secret. */
  encryption?: { passphrase: string } | { secret: Uint8Array };
  /** Surface protocol-level problems (clock drift, bad ops, transport errors). */
  onError?: (err: unknown, ctx: { peer?: string }) => void;
}

export interface SyncedSpace {
  readonly space: string;
  readonly deviceId: string;
  /** Underlying engine, for protocol-level work. */
  readonly engine: SyncEngine;

  // data
  insert(table: string, values: Record<string, Json>): Promise<string>;
  update(table: string, row: string, values: Record<string, Json>): Promise<void>;
  delete(table: string, row: string): Promise<void>;
  get(table: string, row: string): Promise<RowData | undefined>;
  list(table: string): Promise<RowData[]>;

  /** Called after every committed change, local or remote. */
  subscribe(cb: (event: ChangeEvent) => void): () => void;

  // sync
  /** deviceIds currently reachable across all transports. */
  peers(): string[];
  frontier(): Promise<Frontier>;
  /** Reclaim superseded ops. See PROTOCOL.md §9. */
  compact(opts?: { includeTombstones?: boolean; dryRun?: boolean }): Promise<{
    removed: number;
    rowsReclaimed: number;
    blockedBy: string[];
  }>;
  close(): Promise<void>;
}

export async function openSpace(opts: OpenSpaceOptions): Promise<SyncedSpace> {
  const deviceId = opts.deviceId ?? generateDeviceId();
  const space = opts.space;

  const storage = await resolveStorage(opts.storage, space, deviceId);
  const cipher = await resolveCipher(opts.encryption, space);

  const engine = await SyncEngine.open({
    deviceId,
    storage,
    ...(cipher ? { cipher } : {}),
  });

  const transports: Transport[] = [];
  const replicators: Replicator[] = [];
  for (const make of opts.transports ?? []) {
    const transport = await make({ space, deviceId });
    transports.push(transport);
    const replicator = new Replicator({
      engine,
      transport,
      space,
      events: {
        onError: (err, ctx) => opts.onError?.(err, ctx.from ? { peer: ctx.from } : {}),
      },
    });
    replicators.push(replicator);
    await replicator.start();
  }

  return {
    space,
    deviceId,
    engine,
    insert: (t, v) => engine.insert(t, v),
    update: (t, r, v) => engine.update(t, r, v),
    delete: (t, r) => engine.delete(t, r),
    get: (t, r) => engine.get(t, r),
    list: (t) => engine.list(t),
    subscribe: (cb) => engine.subscribe(cb),
    peers: () => {
      const ids = new Set<string>();
      for (const r of replicators) for (const id of r.peerIds) ids.add(id);
      for (const t of transports) {
        const connected = (t as { connectedPeers?: string[] }).connectedPeers;
        for (const id of connected ?? []) ids.add(id);
      }
      return [...ids];
    },
    frontier: () => engine.frontier(),
    compact: async (o = {}) => {
      const stats = await engine.compact(o);
      return {
        removed: stats.removed,
        rowsReclaimed: stats.rowsReclaimed,
        blockedBy: stats.blockedBy,
      };
    },
    close: async () => {
      for (const r of replicators) r.stop();
      for (const t of transports) t.close();
      (storage as { close?: () => void }).close?.();
    },
  };
}

// ---------- transport factories ----------

/** Same-device sync between tabs and workers. No infrastructure. */
export function broadcast(): TransportFactory {
  return ({ space }) => new BroadcastTransport(space);
}

/** Cross-device sync over WebRTC, brokered by a signaling server. */
export function webrtc(opts: {
  signaling: string;
  iceServers?: RTCIceServer[];
  onSignalingState?: (state: SignalingState) => void;
  onError?: (err: unknown, ctx: { peer?: string }) => void;
}): TransportFactory {
  return ({ space, deviceId }) =>
    new WebRTCTransport({
      space,
      deviceId,
      signalingUrl: opts.signaling,
      ...(opts.iceServers ? { rtcConfig: { iceServers: opts.iceServers } } : {}),
      ...(opts.onSignalingState ? { onSignalingState: opts.onSignalingState } : {}),
      ...(opts.onError ? { onError: opts.onError } : {}),
    });
}

/**
 * Serverless pairing: the two devices exchange offer/answer blobs by QR code
 * or copy-paste. Create the transport yourself so you can drive the handshake,
 * then hand it to openSpace via `existing()`.
 */
export function manualPair(opts: {
  deviceId: string;
  iceServers?: RTCIceServer[];
  onState?: (state: ManualPairState) => void;
}): ManualPairTransport {
  return new ManualPairTransport({
    deviceId: opts.deviceId,
    ...(opts.iceServers ? { rtcConfig: { iceServers: opts.iceServers } } : {}),
    ...(opts.onState ? { onState: opts.onState } : {}),
  });
}

/** Wrap an already-constructed transport (e.g. a paired ManualPairTransport). */
export function existing(transport: Transport): TransportFactory {
  return () => transport;
}

// ---------- internals ----------

async function resolveStorage(
  storage: OpenSpaceOptions["storage"],
  space: string,
  deviceId: string,
): Promise<StorageAdapter> {
  if (storage && typeof storage !== "string") return storage;
  if (storage === "memory") return new MemoryAdapter();
  if (storage === "indexeddb" || storage === undefined) {
    if (globalThis.indexedDB) return IdbAdapter.open(`${space}:${deviceId}`);
    if (storage === "indexeddb") {
      throw new Error("IndexedDB is not available in this environment");
    }
    return new MemoryAdapter(); // sensible default outside browsers
  }
  throw new Error(`unknown storage option: ${String(storage)}`);
}

async function resolveCipher(
  enc: OpenSpaceOptions["encryption"],
  space: string,
): Promise<SpaceCipher | undefined> {
  if (!enc) return undefined;
  if ("passphrase" in enc) return SpaceCipher.fromPassphrase(enc.passphrase, space);
  return new SpaceCipher(enc.secret);
}

// ---------- re-exports ----------

export {
  SyncEngine,
  Replicator,
  MemoryAdapter,
  generateDeviceId,
  type ChangeEvent,
  type Frontier,
  type Json,
  type Op,
  type RowData,
  type StorageAdapter,
  type Transport,
} from "@tangentfeed/core";
export { IdbAdapter } from "@tangentfeed/adapter-idb";
export { SpaceCipher } from "@tangentfeed/crypto";
export { BroadcastTransport } from "@tangentfeed/transport-broadcast";
export {
  WebRTCTransport,
  ManualPairTransport,
  type ManualPairState,
  type SignalingState,
} from "@tangentfeed/transport-webrtc";
