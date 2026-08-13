import { describe, it, expect } from "vitest";
import { s, defineSchema } from "../src/index.js";

describe("field builders", () => {
  it("records the kind and default flags", () => {
    const f = s.string();
    expect(f.kind).toBe("string");
    expect(f.isOptional).toBe(false);
    expect(f.isNullable).toBe(false);
    expect(f.hasDefault).toBe(false);
  });

  it("optional() sets isOptional without mutating the original", () => {
    const base = s.string();
    const opt = base.optional();
    expect(opt.isOptional).toBe(true);
    expect(base.isOptional).toBe(false);
  });

  it("default() records the value and does not set isOptional", () => {
    const f = s.boolean().default(false);
    expect(f.hasDefault).toBe(true);
    expect(f.defaultValue).toBe(false);
    expect(f.isOptional).toBe(false);
  });

  it("nullable() is independent of optional()", () => {
    const f = s.number().nullable();
    expect(f.isNullable).toBe(true);
    expect(f.isOptional).toBe(false);
  });

  it("array() records its element field", () => {
    const f = s.array(s.string());
    expect(f.kind).toBe("array");
    expect(f.element?.kind).toBe("string");
  });

  it("object() records its shape", () => {
    const f = s.object({ lat: s.number(), lon: s.number() });
    expect(f.kind).toBe("object");
    expect(Object.keys(f.shape ?? {})).toEqual(["lat", "lon"]);
  });

  it("enum() records allowed values", () => {
    const f = s.enum("low", "high");
    expect(f.kind).toBe("enum");
    expect(f.values).toEqual(["low", "high"]);
  });

  it("defineSchema returns the shape unchanged", () => {
    const schema = defineSchema({ tasks: { title: s.string() } });
    expect(schema.tasks.title.kind).toBe("string");
  });
});
