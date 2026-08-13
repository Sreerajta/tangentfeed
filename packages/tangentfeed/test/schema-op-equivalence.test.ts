import { describe, it, expect } from "vitest";
import { openSpace } from "../src/index.js";
import { s, defineSchema } from "@tangentfeed/schema";
import type { Op } from "@tangentfeed/core";

const schema = defineSchema({
  tasks: {
    title: s.string(),
    done: s.boolean().default(false),
    tags: s.array(s.string()).default([]),
  },
});

/** Every defaulted column supplied explicitly, so the two runs write the same cells. */
const ROWS = [
  { title: "a", done: false, tags: [] },
  { title: "b", done: true, tags: ["x"] },
  { title: "c", done: false, tags: ["y", "z"] },
];

/** Ops minus the fields that legitimately differ between runs (ids embed time). */
const shape = (ops: readonly Op[]) =>
  ops
    .map((o) => ({ table: o.table, column: o.column, value: o.value }))
    .sort((a, b) =>
      `${a.table}.${a.column}.${JSON.stringify(a.value)}`.localeCompare(
        `${b.table}.${b.column}.${JSON.stringify(b.value)}`,
      ),
    );

async function collect(useSchema: boolean) {
  const db = useSchema
    ? await openSpace({ space: `eq-${Math.random()}`, storage: "memory", schema })
    : await openSpace({ space: `eq-${Math.random()}`, storage: "memory" });
  const ops: Op[] = [];
  const stop = db.subscribe((e) => ops.push(...e.ops));
  for (const row of ROWS) {
    await (db.insert as (t: string, v: unknown) => Promise<string>)("tasks", row);
  }
  stop();
  await db.close();
  return ops;
}

describe("schema layer is op-stream neutral", () => {
  it("emits identical ops with and without a schema", async () => {
    const withSchema = await collect(true);
    const without = await collect(false);
    expect(shape(withSchema)).toEqual(shape(without));
  });

  it("emits the same number of ops", async () => {
    const withSchema = await collect(true);
    const without = await collect(false);
    expect(withSchema.length).toBe(without.length);
  });

  it("defaults produce real cells, indistinguishable from explicit values", async () => {
    const db = await openSpace({ space: `d-${Math.random()}`, storage: "memory", schema });
    const ops: Op[] = [];
    const stop = db.subscribe((e) => ops.push(...e.ops));
    await db.insert("tasks", { title: "a" });
    stop();
    expect(ops.map((o) => o.column).sort()).toEqual(["done", "tags", "title"]);
    await db.close();
  });
});
