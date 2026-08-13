import { describe, it, expectTypeOf } from "vitest";
import { useRow, useRows, useSpace, useTable } from "../src/index.js";
import { s, defineSchema } from "@tangentfeed/schema";
import type { SyncedSpace } from "tangentfeed";
import type { RowData } from "@tangentfeed/core";

const schema = defineSchema({
  tasks: { title: s.string(), done: s.boolean().default(false) },
});
type S = typeof schema;

type Task = { id: string; title: string; done: boolean };

describe("typed hooks", () => {
  it("useSpace carries the schema generic through", () => {
    expectTypeOf(useSpace({ space: "x", schema })).toEqualTypeOf<SyncedSpace<S> | null>();
  });

  it("useRows infers the row type", () => {
    const db = null as unknown as SyncedSpace<S>;
    expectTypeOf(useRows(db, "tasks").rows).toEqualTypeOf<Task[]>();
  });

  it("useRow infers the row type", () => {
    const db = null as unknown as SyncedSpace<S>;
    expectTypeOf(useRow(db, "tasks", "r1").row).toEqualTypeOf<Task | undefined>();
  });

  it("useTable types insert values, allowing defaulted columns to be omitted", () => {
    const db = null as unknown as SyncedSpace<S>;
    const { insert } = useTable(db, "tasks");
    expectTypeOf(insert).parameter(0).toEqualTypeOf<{ title: string; done?: boolean }>();
  });

  it("useTable types update values as a partial", () => {
    const db = null as unknown as SyncedSpace<S>;
    const { update } = useTable(db, "tasks");
    expectTypeOf(update).parameter(1).toEqualTypeOf<{ title?: string; done?: boolean }>();
  });

  it("still works untyped", () => {
    const db = null as unknown as SyncedSpace;
    expectTypeOf(useRows(db, "anything").rows).toEqualTypeOf<RowData[]>();
    expectTypeOf(useRow(db, "anything", "r1").row).toEqualTypeOf<RowData | undefined>();
  });
});
