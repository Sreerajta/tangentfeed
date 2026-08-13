import { describe, it, expect } from "vitest";
import { s, defineSchema, validateInsert, validateUpdate, SchemaError } from "../src/index.js";

const schema = defineSchema({
  tasks: {
    title: s.string(),
    done: s.boolean().default(false),
    priority: s.number().optional(),
    note: s.string().nullable(),
    tags: s.array(s.string()).default([]),
    level: s.enum("low", "high"),
    place: s.object({ lat: s.number(), lon: s.number() }),
  },
});

const full = {
  title: "t",
  note: null,
  level: "low",
  place: { lat: 1, lon: 2 },
};

describe("validateInsert", () => {
  it("accepts a valid row and fills defaults", () => {
    const out = validateInsert(schema, "tasks", full);
    expect(out.done).toBe(false);
    expect(out.tags).toEqual([]);
    expect(out.title).toBe("t");
  });

  it("does not require optional fields", () => {
    expect(() => validateInsert(schema, "tasks", full)).not.toThrow();
  });

  it("rejects an unknown table", () => {
    expect(() => validateInsert(schema, "taskz", {})).toThrow(SchemaError);
  });

  it("rejects an unknown column", () => {
    expect(() => validateInsert(schema, "tasks", { ...full, titel: "x" })).toThrow(/unknown column/i);
  });

  it("rejects a missing required field", () => {
    const { title: _omitted, ...rest } = full;
    expect(() => validateInsert(schema, "tasks", rest)).toThrow(/missing/i);
  });

  it("rejects a type mismatch and reports table, column, expected, received", () => {
    try {
      validateInsert(schema, "tasks", { ...full, title: 42 });
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as SchemaError;
      expect(e).toBeInstanceOf(SchemaError);
      expect(e.table).toBe("tasks");
      expect(e.column).toBe("title");
      expect(e.expected).toBe("string");
      expect(e.received).toBe("number");
    }
  });

  it("rejects null unless the field is nullable", () => {
    expect(() => validateInsert(schema, "tasks", { ...full, title: null })).toThrow(SchemaError);
    expect(() => validateInsert(schema, "tasks", { ...full, note: null })).not.toThrow();
  });

  it("checks array elements", () => {
    expect(() => validateInsert(schema, "tasks", { ...full, tags: ["a", 1] })).toThrow(/tags\[1\]/);
  });

  it("checks object interiors", () => {
    expect(() => validateInsert(schema, "tasks", { ...full, place: { lat: 1, lon: "x" } }))
      .toThrow(/place\.lon/);
  });

  it("rejects a value outside an enum", () => {
    expect(() => validateInsert(schema, "tasks", { ...full, level: "mid" })).toThrow(SchemaError);
  });

  it("does not mutate the input", () => {
    const input = { ...full };
    validateInsert(schema, "tasks", input);
    expect("done" in input).toBe(false);
  });
});

describe("validateUpdate", () => {
  it("accepts a partial row", () => {
    expect(() => validateUpdate(schema, "tasks", { done: true })).not.toThrow();
  });

  it("does NOT apply defaults", () => {
    const out = validateUpdate(schema, "tasks", { title: "x" });
    expect(out).toEqual({ title: "x" });
    expect("done" in out).toBe(false);
  });

  it("still rejects unknown columns and type mismatches", () => {
    expect(() => validateUpdate(schema, "tasks", { titel: "x" })).toThrow(SchemaError);
    expect(() => validateUpdate(schema, "tasks", { done: "yes" })).toThrow(SchemaError);
  });

  it("rejects an empty update", () => {
    expect(() => validateUpdate(schema, "tasks", {})).toThrow(/no columns/i);
  });
});
