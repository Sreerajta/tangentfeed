import { describe, it, expectTypeOf } from "vitest";
import { openSpace } from "../src/index.js";
import { s, defineSchema } from "@tangentfeed/schema";

const schema = defineSchema({
  tasks: { title: s.string(), done: s.boolean().default(false) },
});

describe("typed facade", () => {
  it("infers the row type from list()", async () => {
    const db = await openSpace({ space: "x", storage: "memory", schema });
    const rows = await db.list("tasks");
    expectTypeOf(rows).toEqualTypeOf<{ id: string; title: string; done: boolean }[]>();
  });

  it("rejects unknown tables and columns at compile time", async () => {
    const db = await openSpace({ space: "x", storage: "memory", schema });
    // @ts-expect-error unknown table
    await db.insert("taskz", { title: "a" });
    // @ts-expect-error unknown column
    await db.insert("tasks", { titel: "a" });
    // @ts-expect-error missing required column
    await db.insert("tasks", {});
  });

  it("keeps the untyped signature when no schema is given", async () => {
    const db = await openSpace({ space: "x", storage: "memory" });
    expectTypeOf(db.insert).parameter(0).toEqualTypeOf<string>();
  });
});
