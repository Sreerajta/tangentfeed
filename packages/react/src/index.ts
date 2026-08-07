/**
 * React bindings for tangentfeed.
 *
 * The engine is push-based (subscribe fires after every committed batch), so
 * these hooks are thin: they re-read the affected slice and re-render. Reads
 * are local and fast, but they are async, so each hook exposes a `loading`
 * flag for the first paint.
 *
 *   const db = useSpace({ space: "kitchen-42", transports: [broadcast()] });
 *   const { rows } = useRows(db, "tasks");
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  openSpace,
  type OpenSpaceOptions,
  type SyncedSpace,
} from "tangentfeed";
import type { ChangeEvent, RowData } from "@tangentfeed/core";

/**
 * Open a space for the lifetime of the component. Returns null until ready.
 *
 * The options object is captured on first render; changing `space` opens a new
 * database and closes the old one, other fields are ignored after mount (they
 * describe how to connect, not what to display).
 */
export function useSpace(opts: OpenSpaceOptions): SyncedSpace | null {
  const [db, setDb] = useState<SyncedSpace | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    let cancelled = false;
    let opened: SyncedSpace | null = null;
    void openSpace(optsRef.current).then((space) => {
      if (cancelled) {
        void space.close();
        return;
      }
      opened = space;
      setDb(space);
    });
    return () => {
      cancelled = true;
      setDb(null);
      void opened?.close();
    };
    // intentionally keyed on space only: see doc comment
  }, [opts.space]);

  return db;
}

/** Live view of every visible row in a table, sorted by rowId. */
export function useRows(
  db: SyncedSpace | null,
  table: string,
): { rows: RowData[]; loading: boolean } {
  const [rows, setRows] = useState<RowData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!db) {
      setRows([]);
      setLoading(true);
      return;
    }
    let live = true;
    const refresh = async () => {
      const next = await db.list(table);
      if (live) {
        setRows(next);
        setLoading(false);
      }
    };
    void refresh();
    const unsub = db.subscribe((ev: ChangeEvent) => {
      // only re-read when this table actually changed
      if (ev.changes.some((c) => c.table === table)) void refresh();
    });
    return () => {
      live = false;
      unsub();
    };
  }, [db, table]);

  return { rows, loading };
}

/** Live view of one row. `row` is undefined when absent or deleted. */
export function useRow(
  db: SyncedSpace | null,
  table: string,
  rowId: string | null | undefined,
): { row: RowData | undefined; loading: boolean } {
  const [row, setRow] = useState<RowData | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!db || !rowId) {
      setRow(undefined);
      setLoading(!!rowId);
      return;
    }
    let live = true;
    const refresh = async () => {
      const next = await db.get(table, rowId);
      if (live) {
        setRow(next);
        setLoading(false);
      }
    };
    void refresh();
    const unsub = db.subscribe((ev: ChangeEvent) => {
      if (ev.changes.some((c) => c.table === table && c.row === rowId)) void refresh();
    });
    return () => {
      live = false;
      unsub();
    };
  }, [db, table, rowId]);

  return { row, loading };
}

/**
 * Currently reachable peers. Polled, because transports report connection
 * state through their own callbacks rather than the engine's change stream.
 */
export function usePeers(db: SyncedSpace | null, intervalMs = 1000): string[] {
  const [peers, setPeers] = useState<string[]>([]);

  useEffect(() => {
    if (!db) {
      setPeers([]);
      return;
    }
    const tick = () => setPeers(db.peers());
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [db, intervalMs]);

  return peers;
}

/** Stable mutation helpers bound to a table. */
export function useTable(db: SyncedSpace | null, table: string) {
  const insert = useCallback(
    (values: Parameters<SyncedSpace["insert"]>[1]) => {
      if (!db) throw new Error("space not ready");
      return db.insert(table, values);
    },
    [db, table],
  );
  const update = useCallback(
    (row: string, values: Parameters<SyncedSpace["update"]>[2]) => {
      if (!db) throw new Error("space not ready");
      return db.update(table, row, values);
    },
    [db, table],
  );
  const remove = useCallback(
    (row: string) => {
      if (!db) throw new Error("space not ready");
      return db.delete(table, row);
    },
    [db, table],
  );
  return useMemo(() => ({ insert, update, remove }), [insert, update, remove]);
}
