import { describe, it, expect } from "vitest";
import { s, defineSchema, parseRow } from "../src/index.js";

const schema = defineSchema({
  tasks: { title: s.string(), done: s.boolean(), priority: s.number().optional() },
});

describe("parseRow", () => {
  it("accepts a valid row", () => {
    const r = parseRow(schema.tasks, { id: "r1", title: "t", done: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row.title).toBe("t");
  });

  it("does not throw on invalid input", () => {
    expect(() => parseRow(schema.tasks, { id: "r1", title: 42, done: "no" })).not.toThrow();
  });

  it("collects every issue, not just the first", () => {
    const r = parseRow(schema.tasks, { id: "r1", title: 42, done: "no" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.map((i) => i.path).sort()).toEqual(["done", "title"]);
      expect(r.issues.find((i) => i.path === "title")?.received).toBe("number");
    }
  });

  it("reports a missing required column", () => {
    const r = parseRow(schema.tasks, { id: "r1", title: "t" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe("done");
  });

  it("tolerates an absent optional column", () => {
    const r = parseRow(schema.tasks, { id: "r1", title: "t", done: false });
    expect(r.ok).toBe(true);
  });

  it("reports an extra column a newer peer may have written", () => {
    const r = parseRow(schema.tasks, { id: "r1", title: "t", done: true, extra: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe("extra");
  });

  it("rejects a non-object", () => {
    expect(parseRow(schema.tasks, null).ok).toBe(false);
    expect(parseRow(schema.tasks, undefined).ok).toBe(false);
  });

  it("does not treat the id column as unknown", () => {
    const r = parseRow(schema.tasks, { id: "r1", title: "t", done: true });
    expect(r.ok).toBe(true);
  });
});
