import { describe, it, expectTypeOf } from "vitest";
import { s, defineSchema } from "../src/index.js";
import type { Infer, InsertInput, RowOf, UpdateInput, TableName } from "../src/index.js";

const schema = defineSchema({
  tasks: {
    title: s.string(),
    done: s.boolean().default(false),
    priority: s.number().optional(),
    note: s.string().nullable(),
    tags: s.array(s.string()).default([]),
    level: s.enum("low", "high"),
  },
  notes: { body: s.string() },
});

type S = typeof schema;

describe("inference", () => {
  it("infers the read row, including id", () => {
    expectTypeOf<RowOf<S, "tasks">["id"]>().toEqualTypeOf<string>();
    expectTypeOf<RowOf<S, "tasks">["title"]>().toEqualTypeOf<string>();
    expectTypeOf<RowOf<S, "tasks">["tags"]>().toEqualTypeOf<string[]>();
    expectTypeOf<RowOf<S, "tasks">["level"]>().toEqualTypeOf<"low" | "high">();
  });

  it("keeps a defaulted field REQUIRED on read", () => {
    expectTypeOf<RowOf<S, "tasks">>().toHaveProperty("done");
    expectTypeOf<RowOf<S, "tasks">["done"]>().toEqualTypeOf<boolean>();
  });

  it("makes an optional() field optional on read", () => {
    expectTypeOf<RowOf<S, "tasks">["priority"]>().toEqualTypeOf<number | undefined>();
  });

  it("makes nullable widen the value, not the presence", () => {
    expectTypeOf<RowOf<S, "tasks">["note"]>().toEqualTypeOf<string | null>();
  });

  it("makes defaulted and optional fields optional on insert", () => {
    expectTypeOf<InsertInput<S, "tasks">>().toMatchTypeOf<{ title: string }>();
    expectTypeOf<InsertInput<S, "tasks">["done"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<InsertInput<S, "tasks">["priority"]>().toEqualTypeOf<number | undefined>();
  });

  it("makes every field optional on update, and excludes id", () => {
    expectTypeOf<UpdateInput<S, "tasks">["title"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<UpdateInput<S, "tasks">>().not.toHaveProperty("id");
  });

  it("narrows table names", () => {
    expectTypeOf<TableName<S>>().toEqualTypeOf<"tasks" | "notes">();
  });

  it("infers the whole database shape", () => {
    expectTypeOf<Infer<S>["notes"]["body"]>().toEqualTypeOf<string>();
  });
});
