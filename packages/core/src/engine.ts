/**
 * SyncEngine — the heart of the library.
 *
 * Owns: one space's replica. Local writes become ops; remote ops merge by
 * cell-level LWW (PROTOCOL.md §5); all mutation flows through one atomic
 * batch path. Storage and transport are injected; this file knows nothing
 * about platforms.
 */

import { HybridLogicalClock, encodeHlc, decodeHlc } from "./hlc.js";
import {
  BadOpError,
  MAX_BATCH_OPS,
  TOMBSTONE_COLUMN,
  advanceFrontier,
  signedPayload,
  validateOp,
  verifyOp,
  type Frontier,
  type Json,
  type Op,
} from "./op.js";
import {
  deviceIdFromPublicKey,
  generateDeviceKey,
  signPayload,
  type DeviceKey,
} from "./signing.js";
import { cellKey, type StorageAdapter } from "./storage.js";
import {
  blockingPeers,
  compactionHorizon,
  planCompaction,
  winningCells,
  type CompactionOptions,
  type CompactionStats,
} from "./compaction.js";
import { isEncryptedValue, type Cipher } from "./cipher.js";
import { ulid } from "./ulid.js";

export interface RowChange {
  readonly table: string;
  readonly row: string;
}

/** What subscribers see after every committed batch. */
export interface ChangeEvent {
  readonly changes: readonly RowChange[];
  readonly ops: readonly Op[];
  /** "local" = written via insert/update/delete here; "remote" = applied via applyRemoteOps */
  readonly origin: "local" | "remote";
}

export type Subscriber = (event: ChangeEvent) => void;

export interface EngineOptions {
  storage: StorageAdapter;
  physicalClock?: () => number;
  /**
   * Optional end-to-end encryption (PROTOCOL.md §7). When present, local
   * writes are encrypted before entering the op log, so ciphertext is what
   * gets stored, replicated, and relayed. Reads decrypt transparently.
   */
  cipher?: Cipher;
}

export type RowData = { readonly id: string } & Readonly<Record<string, Json>>;

export class SyncEngine {
  readonly deviceId: string;
  private readonly storage: StorageAdapter;
  private readonly clock: HybridLogicalClock;
  private readonly cipher: Cipher | undefined;
  private readonly subscribers = new Set<Subscriber>();
  private readonly deviceKey: DeviceKey;
  /** deviceId -> public key. Seeded with our own so we can verify our own ops. */
  private readonly keys = new Map<string, Uint8Array>();
  /** serializes all mutations; JS is single-threaded but ops are async */
  private mutex: Promise<unknown> = Promise.resolve();

  private constructor(opts: EngineOptions, clock: HybridLogicalClock, key: DeviceKey) {
    this.deviceId = clock.deviceId;
    this.storage = opts.storage;
    this.clock = clock;
    this.cipher = opts.cipher;
    this.deviceKey = key;
    this.keys.set(clock.deviceId, key.publicKey);
  }

  /** This device's public key, for the `hello` message. Section 6.1. */
  get publicKey(): Uint8Array {
    return this.deviceKey.publicKey;
  }

  /** Every device key known to this replica, for the `keys` message. */
  knownKeys(): ReadonlyMap<string, Uint8Array> {
    return new Map(this.keys);
  }

  /**
   * Records a peer's public key.
   *
   * Returns false when the key does not hash to the claimed id. That check is
   * what makes the directory self-validating: a peer can relay keys it learned
   * from others, but cannot invent one for somebody else.
   */
  learnKey(deviceId: string, publicKey: Uint8Array): boolean {
    if (deviceIdFromPublicKey(publicKey) !== deviceId) return false;
    this.keys.set(deviceId, publicKey);
    return true;
  }

  /**
   * Opens a replica. Identity comes from the stored keypair, so a restart keeps
   * the same device rather than minting a new one. Section 4.3.
   */
  static async open(opts: EngineOptions): Promise<SyncEngine> {
    let key = await opts.storage.getDeviceKey();
    if (!key) {
      // Claim the identity before any data op, so it survives being killed early.
      key = generateDeviceKey();
      await opts.storage.setDeviceKey(key);
    }

    const persisted = await opts.storage.getClock();
    const clock = new HybridLogicalClock({
      deviceId: deviceIdFromPublicKey(key.publicKey),
      ...(opts.physicalClock ? { physicalClock: opts.physicalClock } : {}),
      ...(persisted ? { millis: persisted.millis, counter: persisted.counter } : {}),
    });
    return new SyncEngine(opts, clock, key);
  }

  // ---------- reads ----------

  /** Materialized row, or undefined if absent/tombstoned. §5. */
  async get(table: string, row: string): Promise<RowData | undefined> {
    const cells = await this.storage.getRow(table, row);
    if (!cells) return undefined;
    if (isTombstoned(cells)) return undefined;
    return this.materialize(row, cells);
  }

  /** All visible rows of a table, sorted by rowId (ULID = insertion order). */
  async list(table: string): Promise<RowData[]> {
    const out: RowData[] = [];
    for (const row of (await this.storage.listRows(table)).sort()) {
      const cells = await this.storage.getRow(table, row);
      if (cells && !isTombstoned(cells)) out.push(this.materialize(row, cells));
    }
    return out;
  }

  /** Full materialized state; used by tests and conformance vectors. */
  async dump(): Promise<Record<string, Record<string, Record<string, Json>>>> {
    const state: Record<string, Record<string, Record<string, Json>>> = {};
    for (const table of (await this.storage.listTables()).sort()) {
      for (const row of (await this.storage.listRows(table)).sort()) {
        const cells = await this.storage.getRow(table, row);
        if (!cells || isTombstoned(cells)) continue;
        const { id: _id, ...cols } = this.materialize(row, cells);
        (state[table] ??= {})[row] = cols as Record<string, Json>;
      }
    }
    return state;
  }

  // ---------- local writes ----------

  /** Insert a row; returns its generated rowId. */
  async insert(table: string, values: Record<string, Json>): Promise<string> {
    const row = ulid(this.clockMillisForUlid());
    await this.update(table, row, values);
    return row;
  }

  /** Write one op per column. */
  async update(table: string, row: string, values: Record<string, Json>): Promise<void> {
    return this.locked(async () => {
      const ops = Object.entries(values).map(([column, value]) =>
        this.makeLocalOp(table, row, column, value),
      );
      await this.commit(ops, "local");
    });
  }

  /** Row tombstone. §5. */
  async delete(table: string, row: string): Promise<void> {
    return this.locked(async () => {
      await this.commit([this.makeLocalOp(table, row, TOMBSTONE_COLUMN, true)], "local");
    });
  }

  // ---------- sync surface (§6) ----------

  async frontier(): Promise<Frontier> {
    return this.storage.getFrontier();
  }

  /** Ops the caller is missing, given their frontier. §6 step 3. */
  async opsSince(frontier: Frontier): Promise<Op[]> {
    return this.storage.opsSince(frontier);
  }

  /**
   * Apply a batch of remote ops. Validates, drift-checks, dedupes, merges,
   * persists atomically, notifies. Returns number of newly applied ops.
   * Throws BadOpError / ClockDriftError; on throw, nothing was applied.
   */
  async applyRemoteOps(remoteOps: readonly unknown[]): Promise<number> {
    if (remoteOps.length > MAX_BATCH_OPS) {
      throw new BadOpError(`batch exceeds ${MAX_BATCH_OPS} ops`);
    }
    for (const op of remoteOps) validateOp(op);
    const ops = remoteOps as readonly Op[];

    // Signature first: an unauthenticated peer must not be able to provoke a
    // clock error, and a forged op must never reach storage. Section 12.
    for (const op of ops) {
      const publicKey = this.keys.get(op.device);
      if (!publicKey) {
        throw new BadOpError(`unknown device ${op.device}; no key to verify against`);
      }
      if (!verifyOp(op, publicKey)) {
        throw new BadOpError(`bad signature on op ${op.id}`);
      }
    }

    return this.locked(async () => {
      // Advance our clock past the newest remote timestamp; §4.5 drift check
      // happens inside receive(). Checking the max op covers the whole batch.
      const maxOp = ops.reduce<Op | null>(
        (m, o) => (m === null || o.hlc > m.hlc ? o : m),
        null,
      );
      if (maxOp) this.clock.receive(decodeHlc(maxOp.hlc));

      const fresh: Op[] = [];
      for (const op of ops) {
        if (!(await this.storage.hasOp(op.id)) && !fresh.some((f) => f.id === op.id)) {
          fresh.push(op);
        }
      }
      if (fresh.length === 0) {
        // still persist the advanced clock so a restart can't reissue stamps
        await this.storage.applyBatch({
          ops: [],
          winners: new Map(),
          frontier: await this.storage.getFrontier(),
          clock: this.clock.state(),
        });
        return 0;
      }
      await this.commit(fresh, "remote");
      return fresh.length;
    });
  }

  /**
   * Observe a peer's clock from a hello message (§6 step 1). Drift-checks and
   * advances + persists our clock without applying any ops.
   */
  async observeRemoteClock(hlc: string): Promise<void> {
    return this.locked(async () => {
      this.clock.receive(decodeHlc(hlc));
      await this.storage.applyBatch({
        ops: [],
        winners: new Map(),
        frontier: await this.storage.getFrontier(),
        clock: this.clock.state(),
      });
    });
  }

  // ---------- compaction (§9) ----------

  /**
   * Record a peer's frontier, learned from a since/ack exchange. This is the
   * input that lets compaction know what has safely reached everyone.
   */
  async recordPeerFrontier(peer: string, frontier: Frontier): Promise<void> {
    if (peer === this.deviceId) return;
    await this.storage.setPeerFrontier(peer, frontier);
  }

  async peerFrontiers(): Promise<Record<string, Frontier>> {
    return this.storage.getPeerFrontiers();
  }

  /** Number of ops currently retained in the log. */
  async opCount(): Promise<number> {
    return this.storage.opCount();
  }

  /**
   * Reclaim superseded ops (§9). Safe by construction: winners are never
   * dropped, and nothing above the compaction horizon is touched. Tombstone
   * GC is opt-in via `includeTombstones` — see compaction.ts for why.
   */
  async compact(opts: CompactionOptions = {}): Promise<CompactionStats> {
    return this.locked(async () => {
      const own = await this.storage.getFrontier();
      const peers = await this.storage.getPeerFrontiers();
      const horizon = compactionHorizon(own, peers);
      const winners = await winningCells(this.storage);
      const ops = await this.storage.allOps();
      const plan = planCompaction(ops, winners, horizon, opts);
      if (!opts.dryRun && (plan.opIds.length > 0 || plan.cellKeys.length > 0)) {
        await this.storage.compact({ opIds: plan.opIds, cellKeys: plan.cellKeys });
      }
      return { ...plan.stats, blockedBy: blockingPeers(own, peers) };
    });
  }

  // ---------- subscriptions ----------

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  // ---------- internals ----------

  private makeLocalOp(table: string, row: string, column: string, value: Json): Op {
    const hlc = encodeHlc(this.clock.now());
    // Tombstones stay plaintext: §5 merge must work for peers that cannot
    // decrypt. Everything else is encrypted before it enters the log.
    const stored =
      this.cipher && column !== TOMBSTONE_COLUMN ? this.cipher.encrypt(value, hlc) : value;
    // Encrypt-then-sign: `stored` is already the ciphertext, so a keyless peer
    // can still verify everything it forwards. Section 12.
    const unsigned = { id: hlc, table, row, column, value: stored, hlc, device: this.deviceId };
    const op: Op = {
      ...unsigned,
      sig: signPayload(signedPayload(unsigned), this.deviceKey.privateKey),
    };
    validateOp(op); // reject bad names/values before they enter the log
    return op;
  }

  /**
   * The single mutation path (local and remote both land here):
   * compute LWW winners for affected cells, advance frontier, persist
   * atomically, notify subscribers. §5, §8.2.
   */
  private async commit(ops: readonly Op[], origin: "local" | "remote"): Promise<void> {
    const winners = new Map<string, Op>();
    let frontier = await this.storage.getFrontier();

    for (const op of ops) {
      const key = cellKey(op.table, op.row, op.column);
      const pending = winners.get(key);
      const current = pending ?? (await this.storage.getWinner(op.table, op.row, op.column));
      // LWW: string compare === HLC order (§4.2)
      if (current === undefined || op.hlc > current.hlc) {
        winners.set(key, op);
      } else if (pending === undefined) {
        // losing op: still logged, but re-assert the current winner so the
        // batch is self-contained for the adapter
        winners.set(key, current);
      }
      frontier = advanceFrontier(frontier, op);
    }

    await this.storage.applyBatch({
      ops,
      winners,
      frontier,
      clock: this.clock.state(),
    });

    const changed = [...new Set(ops.map((o) => o.table + "\u0000" + o.row))].map((k) => {
      const [table, row] = k.split("\u0000") as [string, string];
      return { table, row };
    });
    const event: ChangeEvent = { changes: changed, ops, origin };
    for (const cb of this.subscribers) cb(event);
  }

  /** Decrypt (if needed) and shape stored cells into a row. */
  private materialize(row: string, cells: ReadonlyMap<string, Op>): RowData {
    const out: Record<string, Json> = {};
    for (const [column, op] of cells) {
      if (column === TOMBSTONE_COLUMN) continue;
      const value =
        this.cipher && isEncryptedValue(op.value)
          ? this.cipher.decrypt(op.value, op.id)
          : op.value;
      if (value !== null) out[column] = value;
    }
    return { id: row, ...out };
  }

  private clockMillisForUlid(): number {
    const s = this.clock.state();
    return Math.max(s.millis, Date.now()) % 2 ** 48;
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.catch(() => undefined);
    return run;
  }
}

// ---------- helpers ----------

function isTombstoned(cells: ReadonlyMap<string, Op>): boolean {
  return cells.get(TOMBSTONE_COLUMN)?.value === true;
}



/**
 * Test/utility helper: one full bidirectional sync between two engines
 * (§6 steps 2–4 without a wire), including the frontier recording that a real
 * ack performs. That recording is not cosmetic: compaction's safety horizon
 * (§9) is computed from known peer frontiers, so an exchange that skipped it
 * would leave each engine believing it were a lone replica and permit
 * unsafe tombstone reclamation. Repeat until both frontiers are equal for
 * multi-peer quiescence.
 */
export async function syncOnce(a: SyncEngine, b: SyncEngine): Promise<void> {
  // Keys before ops, mirroring §6.1: an op from a device whose key is unknown
  // is rejected, so the directories must meet first.
  for (const [id, k] of a.knownKeys()) b.learnKey(id, k);
  for (const [id, k] of b.knownKeys()) a.learnKey(id, k);

  const [fa, fb] = [await a.frontier(), await b.frontier()];
  const aToB = await a.opsSince(fb);
  const bToA = await b.opsSince(fa);
  if (aToB.length) await b.applyRemoteOps(aToB);
  if (bToA.length) await a.applyRemoteOps(bToA);
  // exchange acks: each side learns how far the other has advanced
  await a.recordPeerFrontier(b.deviceId, await b.frontier());
  await b.recordPeerFrontier(a.deviceId, await a.frontier());
}
