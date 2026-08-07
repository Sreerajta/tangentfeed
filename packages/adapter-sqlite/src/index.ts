/**
 * SQLite storage adapter — PROTOCOL.md §8 on real tables.
 *
 * Schema (three tables, mirroring the IndexedDB layout):
 *
 *   ops   (id PK, table_name, row_id, column_name, value, hlc, device)
 *         The operation log. `id` is the 34-char HLC string, so PRIMARY KEY
 *         order IS causal order — the same trick the IndexedDB adapter uses,
 *         and the reason opsSince() can stream in order with no sort.
 *         Index on (device, hlc) makes frontier-diff queries index-only,
 *         which is the hot path during sync.
 *
 *   cells (table_name, row_id, column_name PK, op_json)
 *         Materialized state: the currently winning op per cell. Composite
 *         primary key gives us per-table and per-row scans for free, without
 *         the string-concatenation keys IndexedDB forced on us.
 *
 *   meta  (key PK, value)
 *         Frontier, persisted clock state, recorded peer frontiers.
 *
 * Atomicity (§8.2): applyBatch and compact run inside a single IMMEDIATE
 * transaction, so a crash mid-apply can never leave the log and materialized
 * state disagreeing.
 *
 * Driver-agnostic: works with better-sqlite3, node:sqlite, bun:sqlite, or
 * expo-sqlite by supplying a ~4-method adapter (see SqliteDriver). Ready-made
 * wrappers for the first two are exported below.
 */

import {
  aboveFrontier,
  type BatchWrite,
  type ClockState,
  type CompactionWrite,
  type Frontier,
  type Op,
  type StorageAdapter,
} from "@tangentfeed/core";

// ---------- driver interface ----------

export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): void;
}

export interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close?(): void;
}

/** Wrap a better-sqlite3 Database. */
export function betterSqliteDriver(db: {
  exec(sql: string): unknown;
  prepare(sql: string): {
    all(...p: unknown[]): unknown[];
    get(...p: unknown[]): unknown;
    run(...p: unknown[]): unknown;
  };
  close(): unknown;
}): SqliteDriver {
  return {
    exec: (sql) => void db.exec(sql),
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        all: (...p) => stmt.all(...p),
        get: (...p) => stmt.get(...p),
        run: (...p) => void stmt.run(...p),
      };
    },
    close: () => void db.close(),
  };
}

/** Wrap a node:sqlite DatabaseSync (Node 22+). */
export function nodeSqliteDriver(db: {
  exec(sql: string): unknown;
  prepare(sql: string): {
    all(...p: unknown[]): unknown[];
    get(...p: unknown[]): unknown;
    run(...p: unknown[]): unknown;
  };
  close(): unknown;
}): SqliteDriver {
  return betterSqliteDriver(db); // same surface
}

// ---------- schema ----------

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ops (
  id          TEXT PRIMARY KEY,
  table_name  TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  column_name TEXT NOT NULL,
  value       TEXT NOT NULL,   -- JSON-encoded, so NULL stays distinguishable
  hlc         TEXT NOT NULL,
  device      TEXT NOT NULL
) WITHOUT ROWID;

-- the sync hot path: "everything from device D above hlc H"
CREATE INDEX IF NOT EXISTS ops_device_hlc ON ops (device, hlc);

CREATE TABLE IF NOT EXISTS cells (
  table_name  TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  column_name TEXT NOT NULL,
  op_json     TEXT NOT NULL,
  PRIMARY KEY (table_name, row_id, column_name)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
`;

interface OpRow {
  id: string;
  table_name: string;
  row_id: string;
  column_name: string;
  value: string;
  hlc: string;
  device: string;
}

export class SqliteAdapter implements StorageAdapter {
  private readonly db: SqliteDriver;
  private readonly stmts: {
    insertOp: SqliteStatement;
    deleteOp: SqliteStatement;
    upsertCell: SqliteStatement;
    deleteCell: SqliteStatement;
    getCell: SqliteStatement;
    rowCells: SqliteStatement;
    tableRows: SqliteStatement;
    tables: SqliteStatement;
    countOp: SqliteStatement;
    countOps: SqliteStatement;
    allOps: SqliteStatement;
    opsAboveFor: SqliteStatement;
    allOpsUnfiltered: SqliteStatement;
    getMeta: SqliteStatement;
    setMeta: SqliteStatement;
  };

  private constructor(db: SqliteDriver) {
    this.db = db;
    db.exec(SCHEMA);
    this.stmts = {
      insertOp: db.prepare(
        `INSERT OR IGNORE INTO ops (id, table_name, row_id, column_name, value, hlc, device)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      deleteOp: db.prepare(`DELETE FROM ops WHERE id = ?`),
      upsertCell: db.prepare(
        `INSERT INTO cells (table_name, row_id, column_name, op_json) VALUES (?, ?, ?, ?)
         ON CONFLICT(table_name, row_id, column_name) DO UPDATE SET op_json = excluded.op_json`,
      ),
      deleteCell: db.prepare(
        `DELETE FROM cells WHERE table_name = ? AND row_id = ? AND column_name = ?`,
      ),
      getCell: db.prepare(
        `SELECT op_json FROM cells WHERE table_name = ? AND row_id = ? AND column_name = ?`,
      ),
      rowCells: db.prepare(
        `SELECT column_name, op_json FROM cells WHERE table_name = ? AND row_id = ?`,
      ),
      tableRows: db.prepare(`SELECT DISTINCT row_id FROM cells WHERE table_name = ?`),
      tables: db.prepare(`SELECT DISTINCT table_name FROM cells`),
      countOp: db.prepare(`SELECT 1 AS found FROM ops WHERE id = ?`),
      countOps: db.prepare(`SELECT COUNT(*) AS n FROM ops`),
      allOps: db.prepare(`SELECT * FROM ops ORDER BY id`),
      opsAboveFor: db.prepare(
        `SELECT * FROM ops WHERE device = ? AND hlc > ? ORDER BY hlc`,
      ),
      allOpsUnfiltered: db.prepare(`SELECT * FROM ops ORDER BY id`),
      getMeta: db.prepare(`SELECT value FROM meta WHERE key = ?`),
      setMeta: db.prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ),
    };
  }

  static open(driver: SqliteDriver): SqliteAdapter {
    return new SqliteAdapter(driver);
  }

  close(): void {
    this.db.close?.();
  }

  // ---------- reads ----------

  async getRow(table: string, row: string): Promise<ReadonlyMap<string, Op> | undefined> {
    const rows = this.stmts.rowCells.all(table, row) as {
      column_name: string;
      op_json: string;
    }[];
    if (rows.length === 0) return undefined;
    const out = new Map<string, Op>();
    for (const r of rows) out.set(r.column_name, JSON.parse(r.op_json) as Op);
    return out;
  }

  async listRows(table: string): Promise<string[]> {
    return (this.stmts.tableRows.all(table) as { row_id: string }[]).map((r) => r.row_id);
  }

  async listTables(): Promise<string[]> {
    return (this.stmts.tables.all() as { table_name: string }[]).map((r) => r.table_name);
  }

  async hasOp(id: string): Promise<boolean> {
    return this.stmts.countOp.get(id) !== undefined;
  }

  async getWinner(table: string, row: string, column: string): Promise<Op | undefined> {
    const rec = this.stmts.getCell.get(table, row, column) as { op_json: string } | undefined;
    return rec ? (JSON.parse(rec.op_json) as Op) : undefined;
  }

  async opsSince(frontier: Frontier): Promise<Op[]> {
    const devices = Object.keys(frontier);
    // With a known frontier, query per device so the (device, hlc) index does
    // the work. Ops from devices the caller has never heard of still need a
    // full scan, so fall back when the frontier is empty.
    if (devices.length === 0) {
      return (this.stmts.allOpsUnfiltered.all() as OpRow[]).map(toOp);
    }
    const seen = new Set<string>();
    const out: Op[] = [];
    for (const device of devices) {
      for (const r of this.stmts.opsAboveFor.all(device, frontier[device]!) as OpRow[]) {
        seen.add(r.id);
        out.push(toOp(r));
      }
    }
    // plus everything from devices absent from the frontier
    for (const r of this.stmts.allOpsUnfiltered.all() as OpRow[]) {
      if (frontier[r.device] === undefined && !seen.has(r.id)) out.push(toOp(r));
    }
    out.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
    return out;
  }

  async getFrontier(): Promise<Frontier> {
    return this.readMeta<Frontier>("frontier") ?? {};
  }

  async getClock(): Promise<ClockState | undefined> {
    return this.readMeta<ClockState>("clock");
  }

  // ---------- compaction support ----------

  async opCount(): Promise<number> {
    return (this.stmts.countOps.get() as { n: number }).n;
  }

  async allOps(): Promise<Op[]> {
    return (this.stmts.allOps.all() as OpRow[]).map(toOp);
  }

  async getPeerFrontiers(): Promise<Record<string, Frontier>> {
    return this.readMeta<Record<string, Frontier>>("peers") ?? {};
  }

  async setPeerFrontier(peer: string, frontier: Frontier): Promise<void> {
    const current = await this.getPeerFrontiers();
    this.writeMeta("peers", { ...current, [peer]: frontier });
  }

  async compact(write: CompactionWrite): Promise<void> {
    this.transaction(() => {
      for (const id of write.opIds) this.stmts.deleteOp.run(id);
      for (const key of write.cellKeys) {
        const [table, row, column] = key.split("\u0000") as [string, string, string];
        this.stmts.deleteCell.run(table, row, column);
      }
    });
  }

  // ---------- the one write path ----------

  async applyBatch(batch: BatchWrite): Promise<void> {
    this.transaction(() => {
      for (const op of batch.ops) {
        this.stmts.insertOp.run(
          op.id,
          op.table,
          op.row,
          op.column,
          JSON.stringify(op.value),
          op.hlc,
          op.device,
        );
      }
      for (const [key, op] of batch.winners) {
        const [table, row, column] = key.split("\u0000") as [string, string, string];
        this.stmts.upsertCell.run(table, row, column, JSON.stringify(op));
      }
      this.stmts.setMeta.run("frontier", JSON.stringify(batch.frontier));
      this.stmts.setMeta.run("clock", JSON.stringify(batch.clock));
    });
  }

  // ---------- helpers ----------

  /** All-or-nothing (§8.2). IMMEDIATE takes the write lock up front. */
  private transaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* rollback of an already-aborted tx */
      }
      throw err;
    }
  }

  private readMeta<T>(key: string): T | undefined {
    const rec = this.stmts.getMeta.get(key) as { value: string } | undefined;
    return rec ? (JSON.parse(rec.value) as T) : undefined;
  }

  private writeMeta(key: string, value: unknown): void {
    this.stmts.setMeta.run(key, JSON.stringify(value));
  }
}

function toOp(r: OpRow): Op {
  return {
    id: r.id,
    table: r.table_name,
    row: r.row_id,
    column: r.column_name,
    value: JSON.parse(r.value),
    hlc: r.hlc,
    device: r.device,
  };
}

// re-export for convenience so callers need not import from core
export { aboveFrontier };
