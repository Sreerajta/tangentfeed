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
import type { ChangeEvent, Json, RowData } from "@tangentfeed/core";
import type {
  InsertInput,
  RowOf,
  SchemaShape,
  TableName,
  UpdateInput,
} from "@tangentfeed/schema";

/**
 * Each hook is generic over the schema so a typed space keeps its types
 * through the binding. With no schema these collapse to the untyped forms the
 * hooks had before, so existing components are unaffected.
 */
type Schema = SchemaShape | undefined;

/** Table names accepted for a given schema. */
type TableArg<S extends Schema> = S extends SchemaShape ? TableName<S> : string;

/** A read row for a given schema and table. */
type RowType<S extends Schema, T> = S extends SchemaShape
  ? T extends keyof S
    ? RowOf<S, T>
    : never
  : RowData;

type InsertArg<S extends Schema, T> = S extends SchemaShape
  ? T extends keyof S
    ? InsertInput<S, T>
    : never
  : Record<string, Json>;

type UpdateArg<S extends Schema, T> = S extends SchemaShape
  ? T extends keyof S
    ? UpdateInput<S, T>
    : never
  : Record<string, Json>;

/**
 * The hooks are thin wrappers whose runtime behaviour does not depend on the
 * schema, so internally they work against the untyped space and re-label at
 * the boundary.
 */
type PlainSpace = SyncedSpace<undefined>;

/**
 * Open a space for the lifetime of the component. Returns null until ready.
 *
 * The options object is captured on first render; changing `space` opens a new
 * database and closes the old one, other fields are ignored after mount (they
 * describe how to connect, not what to display).
 */
export function useSpace<S extends Schema = undefined>(
  opts: OpenSpaceOptions<S>,
): SyncedSpace<S> | null {
  const [db, setDb] = useState<SyncedSpace<S> | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    let cancelled = false;
    let opened: SyncedSpace<S> | null = null;
    const open = openSpace as (o: OpenSpaceOptions<S>) => Promise<SyncedSpace<S>>;
    void open(optsRef.current).then((space) => {
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
export function useRows<S extends Schema = undefined, T extends TableArg<S> = TableArg<S>>(
  db: SyncedSpace<S> | null,
  table: T,
): { rows: RowType<S, T>[]; loading: boolean } {
  const [rows, setRows] = useState<RowData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!db) {
      setRows([]);
      setLoading(true);
      return;
    }
    let live = true;
    const plain = db as unknown as PlainSpace;
    const refresh = async () => {
      const next = await plain.list(table);
      if (live) {
        setRows(next);
        setLoading(false);
      }
    };
    void refresh();
    const unsub = plain.subscribe((ev: ChangeEvent) => {
      // only re-read when this table actually changed
      if (ev.changes.some((c) => c.table === table)) void refresh();
    });
    return () => {
      live = false;
      unsub();
    };
  }, [db, table]);

  return { rows: rows as RowType<S, T>[], loading };
}

/** Live view of one row. `row` is undefined when absent or deleted. */
export function useRow<S extends Schema = undefined, T extends TableArg<S> = TableArg<S>>(
  db: SyncedSpace<S> | null,
  table: T,
  rowId: string | null | undefined,
): { row: RowType<S, T> | undefined; loading: boolean } {
  const [row, setRow] = useState<RowData | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!db || !rowId) {
      setRow(undefined);
      setLoading(!!rowId);
      return;
    }
    let live = true;
    const plain = db as unknown as PlainSpace;
    const refresh = async () => {
      const next = await plain.get(table, rowId);
      if (live) {
        setRow(next);
        setLoading(false);
      }
    };
    void refresh();
    const unsub = plain.subscribe((ev: ChangeEvent) => {
      if (ev.changes.some((c) => c.table === table && c.row === rowId)) void refresh();
    });
    return () => {
      live = false;
      unsub();
    };
  }, [db, table, rowId]);

  return { row: row as RowType<S, T> | undefined, loading };
}

/**
 * Currently reachable peers. Polled, because transports report connection
 * state through their own callbacks rather than the engine's change stream.
 */
export function usePeers<S extends Schema = undefined>(
  db: SyncedSpace<S> | null,
  intervalMs = 1000,
): string[] {
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
export function useTable<S extends Schema = undefined, T extends TableArg<S> = TableArg<S>>(
  db: SyncedSpace<S> | null,
  table: T,
) {
  const insert = useCallback(
    (values: InsertArg<S, T>): Promise<string> => {
      if (!db) throw new Error("space not ready");
      return (db as unknown as PlainSpace).insert(table, values as Record<string, Json>);
    },
    [db, table],
  );
  const update = useCallback(
    (row: string, values: UpdateArg<S, T>): Promise<void> => {
      if (!db) throw new Error("space not ready");
      return (db as unknown as PlainSpace).update(table, row, values as Record<string, Json>);
    },
    [db, table],
  );
  const remove = useCallback(
    (row: string): Promise<void> => {
      if (!db) throw new Error("space not ready");
      return (db as unknown as PlainSpace).delete(table, row);
    },
    [db, table],
  );
  return useMemo(() => ({ insert, update, remove }), [insert, update, remove]);
}
