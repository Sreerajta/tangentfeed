import { describe, it, expect } from "vitest";
import { openSpace } from "../src/index.js";
import { s, defineSchema, SchemaError } from "@tangentfeed/schema";

const schema = defineSchema({
  tasks: {
    title: s.string(),
    done: s.boolean().default(false),
    priority: s.number().optional(),
  },
});

const open = () => openSpace({ space: `t-${Math.random()}`, storage: "memory", schema });

describe("openSpace with a schema", () => {
  it("fills defaults on insert", async () => {
    const db = await open();
    const id = await db.insert("tasks", { title: "oat milk" });
    const row = await db.get("tasks", id);
    expect(row?.done).toBe(false);
    await db.close();
  });

  it("rejects an unknown column", async () => {
    const db = await open();
    await expect(db.insert("tasks", { titel: "typo" } as never)).rejects.toThrow(SchemaError);
    await db.close();
  });

  it("rejects an unknown table", async () => {
    const db = await open();
    await expect(db.insert("taskz" as never, {} as never)).rejects.toThrow(SchemaError);
    await db.close();
  });

  it("rejects a type mismatch", async () => {
    const db = await open();
    await expect(db.insert("tasks", { title: 42 } as never)).rejects.toThrow(SchemaError);
    await db.close();
  });

  it("does not write anything when validation fails", async () => {
    const db = await open();
    await expect(db.insert("tasks", { title: 42 } as never)).rejects.toThrow();
    expect(await db.list("tasks")).toEqual([]);
    await db.close();
  });

  it("validates partial updates without applying defaults", async () => {
    const db = await open();
    const id = await db.insert("tasks", { title: "a", done: true });
    await db.update("tasks", id, { title: "b" });
    const row = await db.get("tasks", id);
    expect(row?.title).toBe("b");
    expect(row?.done).toBe(true);
    await db.close();
  });

  it("rejects an invalid update", async () => {
    const db = await open();
    const id = await db.insert("tasks", { title: "a" });
    await expect(db.update("tasks", id, { done: "yes" } as never)).rejects.toThrow(SchemaError);
    await db.close();
  });
});

describe("openSpace without a schema", () => {
  it("behaves exactly as before", async () => {
    const db = await openSpace({ space: `u-${Math.random()}`, storage: "memory" });
    const id = await db.insert("anything", { whatever: 1 });
    const row = await db.get("anything", id);
    expect(row?.whatever).toBe(1);
    await db.close();
  });
});
