/**
 * Storage abstraction — PROTOCOL.md §8.
 *
 * The engine talks ONLY to this interface. Adapters are dumb byte movers with
 * one hard obligation: applyBatch is atomic (§8.2). MemoryAdapter is the
 * reference used by tests; IndexedDB/SQLite adapters come in M2+.
 */

import type { Frontier, Op } from "./op.js";

export interface ClockState {
  readonly millis: number;
  readonly counter: number;
}

export interface BatchWrite {
  /** ops to append to the log (already deduped by the engine) */
  readonly ops: readonly Op[];
  /** new winning op per affected cell, keyed by cellKey() */
  readonly winners: ReadonlyMap<string, Op>;
  /** frontier after this batch */
  readonly frontier: Frontier;
  /** clock state after this batch */
  readonly clock: ClockState;
}

/** Ops and cells to physically remove during compaction (§9). */
export interface CompactionWrite {
  /** op ids to delete from the log */
  readonly opIds: readonly string[];
  /** materialized cell keys to forget (tombstone GC only) */
  readonly cellKeys: readonly string[];
}

export interface StorageAdapter {
  /** All winning cells of a row: column → winning op. undefined if none. */
  getRow(table: string, row: string): Promise<ReadonlyMap<string, Op> | undefined>;
  /** rowIds that have at least one cell op in this table (incl. tombstoned). */
  listRows(table: string): Promise<string[]>;
  /** Table names that have at least one op. */
  listTables(): Promise<string[]>;
  hasOp(id: string): Promise<boolean>;
  /** Current winner for one cell. */
  getWinner(table: string, row: string, column: string): Promise<Op | undefined>;
  /** Every stored op strictly above `frontier`, sorted by hlc. §6 step 3. */
  opsSince(frontier: Frontier): Promise<Op[]>;
  getFrontier(): Promise<Frontier>;
  getClock(): Promise<ClockState | undefined>;
  /** Atomic, all-or-nothing. §8.2. */
  applyBatch(batch: BatchWrite): Promise<void>;

  // ---- compaction support (§9) ----

  /** Total ops currently retained in the log. */
  opCount(): Promise<number>;
  /** Every op in the log, ascending by hlc. Used by compaction scans. */
  allOps(): Promise<Op[]>;
  /** Last known frontier of each peer, from since/ack exchanges (§6). */
  getPeerFrontiers(): Promise<Record<string, Frontier>>;
  /** Record a peer's frontier. */
  setPeerFrontier(peer: string, frontier: Frontier): Promise<void>;
  /** Atomically remove ops (and, for tombstone GC, cells). */
  compact(write: CompactionWrite): Promise<void>;
}

const SEP = "\u0000";
export function cellKey(table: string, row: string, column: string): string {
  return table + SEP + row + SEP + column;
}

export class MemoryAdapter implements StorageAdapter {
  private opsById = new Map<string, Op>();
  /** table → row → column → winning op */
  private tables = new Map<string, Map<string, Map<string, Op>>>();
  private frontier: Frontier = {};
  private clock: ClockState | undefined;
  private peerFrontiers: Record<string, Frontier> = {};

  async getRow(table: string, row: string): Promise<ReadonlyMap<string, Op> | undefined> {
    return this.tables.get(table)?.get(row);
  }

  async listRows(table: string): Promise<string[]> {
    return [...(this.tables.get(table)?.keys() ?? [])];
  }

  async listTables(): Promise<string[]> {
    return [...this.tables.keys()];
  }

  async hasOp(id: string): Promise<boolean> {
    return this.opsById.has(id);
  }

  async getWinner(table: string, row: string, column: string): Promise<Op | undefined> {
    return this.tables.get(table)?.get(row)?.get(column);
  }

  async opsSince(frontier: Frontier): Promise<Op[]> {
    const out: Op[] = [];
    for (const op of this.opsById.values()) {
      const seen = frontier[op.device];
      if (seen === undefined || op.hlc > seen) out.push(op);
    }
    out.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
    return out;
  }

  async getFrontier(): Promise<Frontier> {
    return this.frontier;
  }

  async getClock(): Promise<ClockState | undefined> {
    return this.clock;
  }

  async opCount(): Promise<number> {
    return this.opsById.size;
  }

  async allOps(): Promise<Op[]> {
    return [...this.opsById.values()].sort((a, b) =>
      a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0,
    );
  }

  async getPeerFrontiers(): Promise<Record<string, Frontier>> {
    return this.peerFrontiers;
  }

  async setPeerFrontier(peer: string, frontier: Frontier): Promise<void> {
    this.peerFrontiers = { ...this.peerFrontiers, [peer]: frontier };
  }

  async compact(write: CompactionWrite): Promise<void> {
    const newOps = new Map(this.opsById);
    for (const id of write.opIds) newOps.delete(id);
    const newTables = new Map(this.tables);
    for (const key of write.cellKeys) {
      const [table, row, column] = key.split(SEP) as [string, string, string];
      const rows = new Map(newTables.get(table) ?? []);
      const cells = new Map(rows.get(row) ?? []);
      cells.delete(column);
      if (cells.size === 0) rows.delete(row);
      else rows.set(row, cells);
      if (rows.size === 0) newTables.delete(table);
      else newTables.set(table, rows);
    }
    this.opsById = newOps;
    this.tables = newTables;
  }

  async applyBatch(batch: BatchWrite): Promise<void> {
    // In-memory "transaction": build everything, then swap. A thrown error
    // before the swap leaves prior state untouched.
    const newOps = new Map(this.opsById);
    for (const op of batch.ops) newOps.set(op.id, op);
    const newTables = new Map(this.tables);
    for (const [key, op] of batch.winners) {
      const [table, row, column] = key.split(SEP) as [string, string, string];
      const rows = new Map(newTables.get(table) ?? []);
      const cells = new Map(rows.get(row) ?? []);
      cells.set(column, op);
      rows.set(row, cells);
      newTables.set(table, rows);
    }
    this.opsById = newOps;
    this.tables = newTables;
    this.frontier = batch.frontier;
    this.clock = batch.clock;
  }
}
