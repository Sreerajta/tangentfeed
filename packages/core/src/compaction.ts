/**
 * Compaction — PROTOCOL.md §9.
 *
 * The op log grows forever unless superseded ops are reclaimed. An op is
 * droppable when BOTH hold:
 *
 *   (a) it is not the winning op for its cell, and
 *   (b) every KNOWN peer's frontier has passed it.
 *
 * Condition (b) uses the "compaction horizon": per writer device, the MINIMUM
 * highest-seen HLC across our own frontier and every peer frontier we have
 * recorded from since/ack exchanges. Any op at or below the horizon has
 * demonstrably reached everyone we know about.
 *
 * Why (a) alone would seem sufficient — and why it isn't:
 * dropping a superseded cell value is harmless for LWW convergence, because a
 * peer that never receives it will still receive the winner. The reason (b)
 * exists is TOMBSTONES. Per §5 a row stays hidden because the tombstone is the
 * winning op on the "-" cell, even when later cell writes carry higher HLCs.
 * If a tombstone were forgotten while some peer still held un-synced writes
 * for that row, those writes would arrive later, find no tombstone, and
 * RESURRECT deleted data.
 *
 * Tombstone GC is therefore doubly guarded, and reclaims the row WHOLE:
 *   - the winning "-" op must be a tombstone the horizon has passed, and
 *   - every op belonging to that row must also be below the horizon, and
 *   - all of the row's ops AND materialized cells are removed together.
 * Removing the tombstone while leaving the row's other cells behind would
 * resurrect the row locally on the very next read — the exact failure this
 * module's tests exist to prevent.
 *
 * Consequence worth surfacing to users: one long-absent peer pins the horizon
 * and blocks reclamation. `compact()` reports which peers hold it back rather
 * than silently doing nothing. And because the horizon is only as good as the
 * peer frontiers we have recorded, a replica that has never completed a sync
 * treats itself as alone — correct for a genuinely single-device user, and a
 * further reason tombstone GC requires an explicit opt-in.
 */

import { TOMBSTONE_COLUMN, type Frontier, type Op } from "./op.js";
import { cellKey, type StorageAdapter } from "./storage.js";

const ZERO_HLC = "";
const SEP = "\u0000";

export interface CompactionOptions {
  /**
   * Also reclaim tombstoned rows entirely once the horizon has passed every
   * op of the row. Default false: §9 advises v1 implementations not to GC
   * tombstones by default, because a peer offline beyond the horizon can no
   * longer learn that the row was deleted.
   */
  includeTombstones?: boolean;
  /** Report what would be removed without touching storage. */
  dryRun?: boolean;
}

export interface CompactionStats {
  /** ops examined */
  scanned: number;
  /** ops removed (superseded ops, plus all ops of reclaimed rows) */
  removed: number;
  /** tombstoned rows reclaimed whole (0 unless includeTombstones) */
  rowsReclaimed: number;
  /** ops retained because they are winners */
  retainedWinners: number;
  /** ops retained because the horizon has not passed them */
  retainedAboveHorizon: number;
  /** peers whose lagging frontier pins the horizon; empty means unblocked */
  blockedBy: string[];
}

/**
 * Per-writer-device minimum of (our frontier, every known peer frontier).
 * A missing entry means that peer has seen nothing from that device, which
 * pins the horizon to zero for it.
 */
export function compactionHorizon(
  own: Frontier,
  peerFrontiers: Record<string, Frontier>,
): Frontier {
  const horizon: Record<string, string> = { ...own };
  for (const frontier of Object.values(peerFrontiers)) {
    for (const device of Object.keys(horizon)) {
      const seen = frontier[device] ?? ZERO_HLC;
      if (seen < horizon[device]!) horizon[device] = seen;
    }
  }
  return horizon;
}

/** Peers whose frontier lags ours (and therefore hold the horizon back). */
export function blockingPeers(
  own: Frontier,
  peerFrontiers: Record<string, Frontier>,
): string[] {
  const blockers: string[] = [];
  for (const [peer, frontier] of Object.entries(peerFrontiers)) {
    for (const [device, ours] of Object.entries(own)) {
      if ((frontier[device] ?? ZERO_HLC) < ours) {
        blockers.push(peer);
        break;
      }
    }
  }
  return blockers.sort();
}

function rowKeyOf(op: Op): string {
  return op.table + SEP + op.row;
}

/**
 * Decide what to reclaim. Pure: takes a snapshot, returns a plan. Keeping the
 * safety rules out of the storage layer makes them directly testable.
 *
 * @param winningCells cellKey → winning op (i.e. the materialized state)
 */
export function planCompaction(
  ops: readonly Op[],
  winningCells: ReadonlyMap<string, Op>,
  horizon: Frontier,
  opts: CompactionOptions,
): { opIds: string[]; cellKeys: string[]; stats: Omit<CompactionStats, "blockedBy"> } {
  const winnerIds = new Set<string>();
  for (const op of winningCells.values()) winnerIds.add(op.id);

  const below = (op: Op) => op.hlc <= (horizon[op.device] ?? ZERO_HLC);

  // ---- pass 1: which tombstoned rows may be reclaimed whole? ----
  const doomedRows = new Set<string>();
  if (opts.includeTombstones) {
    const candidates = new Set<string>();
    for (const [key, winner] of winningCells) {
      if (winner.column === TOMBSTONE_COLUMN && winner.value === true && below(winner)) {
        candidates.add(key.slice(0, key.lastIndexOf(SEP)));
      }
    }
    // only reclaim a row when EVERY op it owns is below the horizon; otherwise
    // some peer could still be missing one of them
    const blockedRows = new Set<string>();
    for (const op of ops) {
      if (!below(op)) blockedRows.add(rowKeyOf(op));
    }
    for (const row of candidates) {
      if (!blockedRows.has(row)) doomedRows.add(row);
    }
  }

  // ---- pass 2: plan removals ----
  const opIds: string[] = [];
  const cellKeys = new Set<string>();
  let removed = 0;
  let retainedWinners = 0;
  let retainedAboveHorizon = 0;

  for (const op of ops) {
    if (doomedRows.has(rowKeyOf(op))) {
      opIds.push(op.id);
      cellKeys.add(cellKey(op.table, op.row, op.column));
      removed += 1;
      continue;
    }
    if (!below(op)) {
      retainedAboveHorizon += 1;
      continue;
    }
    if (!winnerIds.has(op.id)) {
      opIds.push(op.id);
      removed += 1;
      continue;
    }
    retainedWinners += 1;
  }

  // sweep every cell of a doomed row, including ones whose winning op was
  // already reclaimed in an earlier round
  for (const key of winningCells.keys()) {
    if (doomedRows.has(key.slice(0, key.lastIndexOf(SEP)))) cellKeys.add(key);
  }

  return {
    opIds,
    cellKeys: [...cellKeys],
    stats: {
      scanned: ops.length,
      removed,
      rowsReclaimed: doomedRows.size,
      retainedWinners,
      retainedAboveHorizon,
    },
  };
}

/** Snapshot of materialized state: cellKey → winning op. */
export async function winningCells(storage: StorageAdapter): Promise<Map<string, Op>> {
  const out = new Map<string, Op>();
  for (const table of await storage.listTables()) {
    for (const row of await storage.listRows(table)) {
      const cells = await storage.getRow(table, row);
      for (const [column, op] of cells ?? []) {
        out.set(cellKey(table, row, column), op);
      }
    }
  }
  return out;
}
