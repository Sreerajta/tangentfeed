/**
 * Replication — PROTOCOL.md §6 as reusable logic over any transport.
 *
 * A Transport is deliberately dumb: a lossy-ok message bus. `send` delivers to
 * everyone reachable (bus semantics); point-to-point transports implement the
 * same interface by fanning out and letting `to`-filtering discard the rest.
 * The Replicator supplies everything protocol-shaped: hello, frontier
 * exchange, batched op transfer, acks, and live tail.
 *
 * Robustness comes from the engine, not the transport: ops are idempotent and
 * merge is commutative, so lost, duplicated, or reordered messages can only
 * delay convergence, never corrupt it. Any gap heals on the next hello/since
 * exchange.
 */

import type { SyncEngine } from "./engine.js";
import { MAX_BATCH_OPS, type Frontier, type Op } from "./op.js";

export const WIRE_VERSION = 1;
/** Conservative default; well under MAX_BATCH_OPS and typical message limits. */
export const OPS_PER_MESSAGE = 500;

export type WireMsg =
  | { t: "hello"; v: number; space: string; from: string; clock: string }
  | { t: "since"; v: number; space: string; from: string; to: string; have: Frontier }
  | { t: "ops"; v: number; space: string; from: string; to?: string; ops: Op[] }
  | { t: "ack"; v: number; space: string; from: string; to: string; frontier: Frontier };

export interface Transport {
  /** Deliver to all reachable peers. Fire-and-forget; loss is acceptable. */
  send(msg: WireMsg): void;
  /** Register receive callback; returns unsubscribe. */
  onMessage(cb: (msg: WireMsg) => void): () => void;
  /**
   * Optional: fires when a new peer link becomes ready (e.g. a DataChannel
   * opens). Lets the Replicator (re-)send hello to late-connecting peers.
   * Bus transports with no link concept (BroadcastChannel) omit this.
   */
  onPeerConnect?(cb: (peerId?: string) => void): () => void;
  close(): void;
}

export interface ReplicatorEvents {
  onPeersChange?: (peers: ReadonlySet<string>) => void;
  /** Protocol-level problems (drift, bad ops). Replication continues with other peers. */
  onError?: (err: unknown, context: { from?: string }) => void;
}

export class Replicator {
  private readonly engine: SyncEngine;
  private readonly transport: Transport;
  private readonly space: string;
  private readonly events: ReplicatorEvents;
  private readonly peers = new Map<string, { frontier?: Frontier }>();
  private unsubs: (() => void)[] = [];
  private started = false;

  constructor(opts: {
    engine: SyncEngine;
    transport: Transport;
    space: string;
    events?: ReplicatorEvents;
  }) {
    this.engine = opts.engine;
    this.transport = opts.transport;
    this.space = opts.space;
    this.events = opts.events ?? {};
  }

  get peerIds(): ReadonlySet<string> {
    return new Set(this.peers.keys());
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.unsubs.push(this.transport.onMessage((msg) => void this.handle(msg)));

    // when the transport reports a fresh peer link, greet it (§6 step 1)
    if (this.transport.onPeerConnect) {
      this.unsubs.push(
        this.transport.onPeerConnect(() => void this.sendHello()),
      );
    }

    // live tail: forward local commits as they happen (§6 step 5)
    this.unsubs.push(
      this.engine.subscribe((ev) => {
        if (ev.origin !== "local" || ev.ops.length === 0) return;
        for (const chunk of chunks(ev.ops, OPS_PER_MESSAGE)) {
          this.transport.send(this.msg({ t: "ops", ops: chunk }));
        }
      }),
    );

    // announce ourselves (§6 step 1)
    await this.sendHello();
  }

  stop(): void {
    this.started = false;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.peers.clear();
    this.events.onPeersChange?.(this.peerIds);
  }

  private async sendHello(): Promise<void> {
    const latest = (await this.engine.opsSince({})).at(-1)?.hlc;
    this.transport.send(
      this.msg({ t: "hello", clock: latest ?? zeroClock(this.engine.deviceId) }),
    );
  }

  // ---------- inbound ----------

  private async handle(msg: WireMsg): Promise<void> {
    try {
      if (!this.started) return;
      if (msg.space !== this.space || msg.v !== WIRE_VERSION) return;
      if (msg.from === this.engine.deviceId) return; // our own broadcast
      if ("to" in msg && msg.to !== undefined && msg.to !== this.engine.deviceId) return;

      switch (msg.t) {
        case "hello": {
          await this.engine.observeRemoteClock(msg.clock);
          const isNew = !this.peers.has(msg.from);
          if (isNew) {
            this.peers.set(msg.from, {});
            this.events.onPeersChange?.(this.peerIds);
            // greet back so they learn us (their handler sends `since` to us)
            await this.sendHello();
          }
          // ask for what we're missing (§6 step 2) — also on re-hello, which
          // is how a returning peer heals any gap
          this.transport.send(
            this.msg({ t: "since", to: msg.from, have: await this.engine.frontier() }),
          );
          break;
        }
        case "since": {
          this.peers.set(msg.from, { frontier: msg.have });
          // persist for compaction (§9): this is how the engine learns what
          // has safely reached every peer
          await this.engine.recordPeerFrontier(msg.from, msg.have);
          const missing = await this.engine.opsSince(msg.have);
          for (const chunk of chunks(missing, OPS_PER_MESSAGE)) {
            this.transport.send(this.msg({ t: "ops", to: msg.from, ops: chunk }));
          }
          break;
        }
        case "ops": {
          if (msg.ops.length === 0) return;
          const applied = await this.engine.applyRemoteOps(msg.ops);
          if (applied > 0) {
            this.transport.send(
              this.msg({ t: "ack", to: msg.from, frontier: await this.engine.frontier() }),
            );
          }
          break;
        }
        case "ack": {
          this.peers.set(msg.from, { frontier: msg.frontier });
          await this.engine.recordPeerFrontier(msg.from, msg.frontier);
          break;
        }
      }
    } catch (err) {
      this.events.onError?.(err, { from: msg.from });
    }
  }

  private msg<T extends MsgBody>(body: T): WireMsg {
    return {
      v: WIRE_VERSION,
      space: this.space,
      from: this.engine.deviceId,
      ...body,
    } as unknown as WireMsg;
  }
}

/** Omit distributed over each union member, so bodies keep their variant shape. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type MsgBody = DistributiveOmit<WireMsg, "v" | "space" | "from">;

function* chunks<T>(arr: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

function zeroClock(deviceId: string): string {
  return "0".repeat(12) + "-0000-" + deviceId;
}

// keep MAX_BATCH_OPS referenced so protocol constants stay linked
void MAX_BATCH_OPS;
