/**
 * IndexedDB adapter — PROTOCOL.md §8 capabilities on browser storage.
 *
 * Layout (one database per space, name `tangentfeed:{space}`):
 *   ops   — keyPath "id". Since op.id === op.hlc (50-char sortable string),
 *           primary-key order IS global HLC order for free.
 *   cells — key: cellKey(table,row,column) = "table\0row\0column".
 *           value: { key, op } where op is the current winning op.
 *           \u0000 sorts below every legal name char, so prefix ranges give
 *           us per-table and per-row scans without extra indexes.
 *   meta  — "frontier" and "clock" singletons.
 *
 * Atomicity (§8.2): applyBatch issues every put inside ONE readwrite
 * transaction over all three stores; IndexedDB transactions commit
 * all-or-nothing. No foreign awaits happen mid-transaction (that would let
 * the tx auto-commit early); all requests are queued synchronously.
 *
 * Known M2 simplifications (revisit in M8/compaction):
 *   - opsSince scans the whole ops store with a cursor and filters. Fine for
 *     demo scale; a ["device","hlc"] index makes it O(missing) later.
 *   - listTables/listRows scan the cells store by cursor.
 */

import {
  aboveFrontier,
  cellKey,
  type BatchWrite,
  type ClockState,
  type CompactionWrite,
  type DeviceKey,
  type Frontier,
  type Op,
  type StorageAdapter,
} from "@tangentfeed/core";

const SEP = "\u0000";
const HIGH = "\uffff";

export class IdbAdapter implements StorageAdapter {
  private constructor(private readonly db: IDBDatabase) {}

  /**
   * Open (creating on first use) the database for a space.
   * `factory` defaults to globalThis.indexedDB; inject fake-indexeddb in
   * tests or a custom factory in exotic environments.
   */
  static async open(
    space: string,
    factory: IDBFactory = globalThis.indexedDB,
  ): Promise<IdbAdapter> {
    if (!factory) throw new Error("no IndexedDB available in this environment");
    const db = await promisifyOpen(factory.open(`tangentfeed:${space}`, 1));
    return new IdbAdapter(db);
  }

  /** Delete a space's database entirely. */
  static async destroy(
    space: string,
    factory: IDBFactory = globalThis.indexedDB,
  ): Promise<void> {
    await promisifyRequest(factory.deleteDatabase(`tangentfeed:${space}`));
  }

  close(): void {
    this.db.close();
  }

  // ---------- reads ----------

  async getRow(table: string, row: string): Promise<ReadonlyMap<string, Op> | undefined> {
    const prefix = table + SEP + row + SEP;
    const entries = await this.rangeScan("cells", prefix);
    if (entries.length === 0) return undefined;
    const out = new Map<string, Op>();
    for (const { key, op } of entries) {
      out.set(key.slice(prefix.length), op);
    }
    return out;
  }

  async listRows(table: string): Promise<string[]> {
    const prefix = table + SEP;
    const rows = new Set<string>();
    for (const { key } of await this.rangeScan("cells", prefix)) {
      const rest = key.slice(prefix.length);
      rows.add(rest.slice(0, rest.indexOf(SEP)));
    }
    return [...rows];
  }

  async listTables(): Promise<string[]> {
    const tables = new Set<string>();
    for (const { key } of await this.rangeScan("cells", "")) {
      tables.add(key.slice(0, key.indexOf(SEP)));
    }
    return [...tables];
  }

  async hasOp(id: string): Promise<boolean> {
    const tx = this.db.transaction("ops", "readonly");
    const n = await promisifyRequest(tx.objectStore("ops").count(id));
    return n > 0;
  }

  async getWinner(table: string, row: string, column: string): Promise<Op | undefined> {
    const tx = this.db.transaction("cells", "readonly");
    const rec = await promisifyRequest<CellRecord | undefined>(
      tx.objectStore("cells").get(cellKey(table, row, column)),
    );
    return rec?.op;
  }

  async opsSince(frontier: Frontier): Promise<Op[]> {
    const tx = this.db.transaction("ops", "readonly");
    const out: Op[] = [];
    await cursorEach<Op>(tx.objectStore("ops").openCursor(), (op) => {
      if (aboveFrontier(op, frontier)) out.push(op);
    });
    return out; // primary key order === hlc order
  }

  async getFrontier(): Promise<Frontier> {
    const tx = this.db.transaction("meta", "readonly");
    return (
      (await promisifyRequest<Frontier | undefined>(tx.objectStore("meta").get("frontier"))) ??
      {}
    );
  }

  async getClock(): Promise<ClockState | undefined> {
    const tx = this.db.transaction("meta", "readonly");
    return promisifyRequest<ClockState | undefined>(tx.objectStore("meta").get("clock"));
  }

  // ---------- signing identity (§12) ----------

  // Stored as raw Uint8Arrays: structured clone handles typed arrays, so there
  // is nothing to encode and nothing to get wrong on the way back out.

  async getDeviceKey(): Promise<DeviceKey | undefined> {
    const tx = this.db.transaction("meta", "readonly");
    return promisifyRequest<DeviceKey | undefined>(tx.objectStore("meta").get("deviceKey"));
  }

  async setDeviceKey(key: DeviceKey): Promise<void> {
    const tx = this.db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ publicKey: key.publicKey, privateKey: key.privateKey }, "deviceKey");
    await txDone(tx);
  }

  // ---------- compaction support (§9) ----------

  async opCount(): Promise<number> {
    const tx = this.db.transaction("ops", "readonly");
    return promisifyRequest<number>(tx.objectStore("ops").count());
  }

  async allOps(): Promise<Op[]> {
    const tx = this.db.transaction("ops", "readonly");
    const out: Op[] = [];
    await cursorEach<Op>(tx.objectStore("ops").openCursor(), (op) => out.push(op));
    return out; // primary key order === hlc order
  }

  async getPeerFrontiers(): Promise<Record<string, Frontier>> {
    const tx = this.db.transaction("meta", "readonly");
    return (
      (await promisifyRequest<Record<string, Frontier> | undefined>(
        tx.objectStore("meta").get("peers"),
      )) ?? {}
    );
  }

  async setPeerFrontier(peer: string, frontier: Frontier): Promise<void> {
    const current = await this.getPeerFrontiers();
    const tx = this.db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ ...current, [peer]: frontier }, "peers");
    await txDone(tx);
  }

  async compact(write: CompactionWrite): Promise<void> {
    const tx = this.db.transaction(["ops", "cells"], "readwrite");
    const ops = tx.objectStore("ops");
    const cells = tx.objectStore("cells");
    for (const id of write.opIds) ops.delete(id);
    for (const key of write.cellKeys) cells.delete(key);
    await txDone(tx);
  }

  // ---------- the one write path ----------

  async applyBatch(batch: BatchWrite): Promise<void> {
    const tx = this.db.transaction(["ops", "cells", "meta"], "readwrite");
    const ops = tx.objectStore("ops");
    const cells = tx.objectStore("cells");
    const meta = tx.objectStore("meta");
    // Queue every request synchronously; the transaction commits atomically.
    for (const op of batch.ops) ops.put(op);
    for (const [key, op] of batch.winners) cells.put({ key, op } satisfies CellRecord);
    meta.put(batch.frontier, "frontier");
    meta.put(batch.clock, "clock");
    await txDone(tx);
  }

  // ---------- helpers ----------

  private async rangeScan(store: "cells", prefix: string): Promise<CellRecord[]> {
    const tx = this.db.transaction(store, "readonly");
    const range =
      prefix === ""
        ? undefined
        : IDBKeyRange.bound(prefix, prefix + HIGH, false, false);
    const out: CellRecord[] = [];
    await cursorEach<CellRecord>(tx.objectStore(store).openCursor(range ?? null), (rec) =>
      out.push(rec),
    );
    return out;
  }
}

interface CellRecord {
  key: string;
  op: Op;
}

function promisifyOpen(req: IDBOpenDBRequest): Promise<IDBDatabase> {
  req.onupgradeneeded = () => {
    const db = req.result;
    db.createObjectStore("ops", { keyPath: "id" });
    db.createObjectStore("cells", { keyPath: "key" });
    db.createObjectStore("meta");
  };
  return promisifyRequest(req);
}

function promisifyRequest<T>(req: IDBRequest<T> | IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

function cursorEach<T>(
  req: IDBRequest<IDBCursorWithValue | null>,
  fn: (value: T) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      fn(cur.value as T);
      cur.continue();
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB cursor failed"));
  });
}
