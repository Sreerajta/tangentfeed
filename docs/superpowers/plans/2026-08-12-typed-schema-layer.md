# Typed Schema Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@tangentfeed/schema` — a schema DSL that infers TypeScript types and validates local writes, without touching core or altering the wire format.

**Architecture:** A new zero-dependency package holds field descriptors (`builders.ts`), inference types (`types.ts`), and a runtime validator (`validate.ts`). The `tangentfeed` facade gains an optional generic parameter: when a schema is supplied, `insert`/`update` validate before delegating to the engine, and read methods return inferred row types. `packages/core` is not modified.

**Tech Stack:** TypeScript 5.5 (ESM, `moduleResolution: bundler`), vitest 2 (including `expectTypeOf` for type-level tests), tsup for builds, fast-check for property tests.

**Spec:** `docs/superpowers/specs/2026-08-12-typed-schema-layer-design.md`

## Global Constraints

- **Zero runtime dependencies** in `@tangentfeed/schema`. `@tangentfeed/core` may be imported for the `Json` type only (type-only import, erased at build).
- **`packages/core` must not be modified.** The schema layer is a facade-level precondition.
- **Backward compatible.** `openSpace` without `schema` keeps its exact current signature; existing code must compile unchanged.
- **ESM with explicit `.js` extensions** on all relative imports, matching every other package.
- **Package version `0.1.0`**, `"type": "module"`, `main`/`types` pointing at `./dist/`.
- **Validation never inspects remote data.** It runs only in the `insert`/`update` wrappers, before ops are generated.
- **`s.object(shape)` is one cell.** It validates its interior but must never introduce field-level merging.
- Tests import package source as `../src/index.js`; cross-package imports use the alias (e.g. `@tangentfeed/core`) resolved by `vitest.shared.ts`.

---

### Task 1: Scaffold the package and build field descriptors

Creates the package and the `s` DSL. Descriptors are plain data carrying phantom type parameters; validation and inference are built on them in later tasks.

**Files:**
- Create: `packages/schema/package.json`
- Create: `packages/schema/tsconfig.json`
- Create: `packages/schema/vitest.config.ts`
- Create: `packages/schema/src/builders.ts`
- Create: `packages/schema/src/index.ts`
- Test: `packages/schema/test/builders.test.ts`
- Modify: `vitest.shared.ts` (add the alias)
- Modify: `package.json` (add to the root `build` script)

**Interfaces:**
- Consumes: `Json` from `@tangentfeed/core` (type-only).
- Produces: `Field<Out, InOpt, OutOpt>` class with `.optional()`, `.nullable()`, `.default(v)`; the `s` namespace (`s.string`, `s.number`, `s.boolean`, `s.array`, `s.object`, `s.enum`); `defineSchema(shape)`; `type TableShape = Record<string, Field>`; `type SchemaShape = Record<string, TableShape>`.

The three phantom parameters are load-bearing and later tasks depend on their exact meaning:
- `Out` — the value type when read back.
- `InOpt` — `true` if the key may be omitted on `insert` (set by both `.optional()` and `.default()`).
- `OutOpt` — `true` if the key may be absent when read (set by `.optional()` only; a defaulted field is always present).

- [ ] **Step 1: Create the package manifest**

`packages/schema/package.json`:

```json
{
  "name": "@tangentfeed/schema",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "test": "vitest run",
    "build": "tsup src/index.ts --format esm --dts --clean"
  },
  "devDependencies": {
    "@tangentfeed/core": "0.1.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "tsup": "^8.5.0"
  },
  "description": "Typed schema layer for tangentfeed: inference plus local write validation",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/sreerajta/tangentfeed.git",
    "directory": "packages/schema"
  },
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "dist",
    "README.md"
  ]
}
```

`@tangentfeed/core` is a **devDependency**, not a dependency: it is used only for the `Json` type, which is erased at build time. This is what keeps the zero-runtime-dependency claim true.

- [ ] **Step 2: Create tsconfig and vitest config**

`packages/schema/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "test"]
}
```

`packages/schema/vitest.config.ts`:

```ts
import config from "../../vitest.shared.js";
export default config;
```

- [ ] **Step 3: Register the package in the shared vitest aliases**

In `vitest.shared.ts`, add one line to the `aliases` array, after the `crypto` entry:

```ts
  pkg("@tangentfeed/schema", "schema"),
```

- [ ] **Step 4: Add the package to the root build script**

In `package.json`, the root `build` script must build `schema` **before** `tangentfeed`, because the facade will import it. Insert `npm run build -w packages/schema && ` immediately before `npm run build -w packages/tangentfeed`.

The resulting script value:

```
npm run build -w packages/core && npm run build -w packages/adapter-idb && npm run build -w packages/adapter-sqlite && npm run build -w packages/crypto && npm run build -w packages/transport-broadcast && npm run build -w packages/transport-webrtc && npm run build -w packages/signaling-server && npm run build -w packages/schema && npm run build -w packages/tangentfeed && npm run build -w packages/react
```

- [ ] **Step 5: Write the failing test**

`packages/schema/test/builders.test.ts`:

```ts
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
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -w @tangentfeed/schema`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 7: Implement the builders**

`packages/schema/src/builders.ts`:

```ts
/**
 * Field descriptors.
 *
 * A descriptor is plain data (kind + flags) carrying three phantom type
 * parameters that the inference types in ./types.ts read:
 *
 *   Out    — the value type when read back
 *   InOpt  — may the key be omitted on insert?  (.optional() and .default())
 *   OutOpt — may the key be absent when read?   (.optional() only)
 *
 * A defaulted field is optional going in and guaranteed coming out, which is
 * why InOpt and OutOpt are tracked separately rather than as one flag.
 */

import type { Json } from "@tangentfeed/core";

export type FieldKind = "string" | "number" | "boolean" | "array" | "object" | "enum";

export class Field<
  Out = unknown,
  InOpt extends boolean = false,
  OutOpt extends boolean = false,
> {
  readonly kind: FieldKind;
  readonly isOptional: boolean;
  readonly isNullable: boolean;
  readonly hasDefault: boolean;
  readonly defaultValue: Json | undefined;
  readonly element: Field<unknown, boolean, boolean> | undefined;
  readonly shape: Record<string, Field<unknown, boolean, boolean>> | undefined;
  readonly values: readonly (string | number)[] | undefined;

  // Phantom carriers. `declare` means no runtime property is emitted.
  declare readonly __out?: Out;
  declare readonly __inOpt?: InOpt;
  declare readonly __outOpt?: OutOpt;

  constructor(init: {
    kind: FieldKind;
    isOptional?: boolean;
    isNullable?: boolean;
    hasDefault?: boolean;
    defaultValue?: Json | undefined;
    element?: Field<unknown, boolean, boolean> | undefined;
    shape?: Record<string, Field<unknown, boolean, boolean>> | undefined;
    values?: readonly (string | number)[] | undefined;
  }) {
    this.kind = init.kind;
    this.isOptional = init.isOptional ?? false;
    this.isNullable = init.isNullable ?? false;
    this.hasDefault = init.hasDefault ?? false;
    this.defaultValue = init.defaultValue;
    this.element = init.element;
    this.shape = init.shape;
    this.values = init.values;
  }

  private clone(patch: Partial<ConstructorParameters<typeof Field>[0]>) {
    return new Field({
      kind: this.kind,
      isOptional: this.isOptional,
      isNullable: this.isNullable,
      hasDefault: this.hasDefault,
      defaultValue: this.defaultValue,
      element: this.element,
      shape: this.shape,
      values: this.values,
      ...patch,
    });
  }

  /** Key may be omitted on insert, and may be absent when read. */
  optional(): Field<Out, true, true> {
    return this.clone({ isOptional: true }) as Field<Out, true, true>;
  }

  /** Value may be null. Independent of presence. */
  nullable(): Field<Out | null, InOpt, OutOpt> {
    return this.clone({ isNullable: true }) as Field<Out | null, InOpt, OutOpt>;
  }

  /** Key may be omitted on insert; the default is written, so reads always see it. */
  default(value: Out & Json): Field<Out, true, OutOpt> {
    return this.clone({ hasDefault: true, defaultValue: value }) as Field<Out, true, OutOpt>;
  }
}

export type AnyField = Field<unknown, boolean, boolean>;
export type TableShape = Record<string, AnyField>;
export type SchemaShape = Record<string, TableShape>;

export const s = {
  string: () => new Field<string>({ kind: "string" }),
  number: () => new Field<number>({ kind: "number" }),
  boolean: () => new Field<boolean>({ kind: "boolean" }),

  array: <E>(element: Field<E, boolean, boolean>) =>
    new Field<E[]>({ kind: "array", element: element as AnyField }),

  /**
   * Validates its interior and infers a nested type, but remains ONE cell:
   * cell-level LWW merges the whole object atomically. Never add field-level
   * merging inside an object.
   */
  object: <S extends TableShape>(shape: S) =>
    new Field<{ [K in keyof S]: S[K] extends Field<infer O, boolean, boolean> ? O : never }>({
      kind: "object",
      shape,
    }),

  enum: <const V extends readonly (string | number)[]>(...values: V) =>
    new Field<V[number]>({ kind: "enum", values }),
};

/** Identity at runtime; exists to pin the generic so inference has something to read. */
export function defineSchema<S extends SchemaShape>(shape: S): S {
  return shape;
}
```

- [ ] **Step 8: Create the public entry point**

`packages/schema/src/index.ts`:

```ts
export {
  Field,
  s,
  defineSchema,
  type FieldKind,
  type AnyField,
  type TableShape,
  type SchemaShape,
} from "./builders.js";
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -w @tangentfeed/schema`
Expected: PASS, 8 tests.

- [ ] **Step 10: Commit**

```bash
git add packages/schema vitest.shared.ts package.json
git commit -m "feat(schema): field descriptors and the s DSL"
```

---

### Task 2: Runtime validation of local writes

The enforcement half. Pure functions over a schema and a values object — no engine, no storage, so they test in isolation.

**Files:**
- Create: `packages/schema/src/validate.ts`
- Modify: `packages/schema/src/index.ts`
- Test: `packages/schema/test/validate.test.ts`

**Interfaces:**
- Consumes: `Field`, `SchemaShape`, `TableShape` from Task 1.
- Produces:
  - `class SchemaError extends Error` with readonly `table: string`, `column: string | undefined`, `expected: string`, `received: string`.
  - `validateInsert(schema: SchemaShape, table: string, values: Record<string, unknown>): Record<string, Json>` — returns a new object with defaults filled in.
  - `validateUpdate(schema: SchemaShape, table: string, values: Record<string, unknown>): Record<string, Json>` — no defaults, no required-field check.

- [ ] **Step 1: Write the failing test**

`packages/schema/test/validate.test.ts`:

```ts
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
```

`validateUpdate` rejecting `{}` is deliberate: an empty update produces zero ops, which is silently a no-op. Failing loudly beats a write that appears to succeed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @tangentfeed/schema -- validate`
Expected: FAIL — `validateInsert` is not exported.

- [ ] **Step 3: Implement the validator**

`packages/schema/src/validate.ts`:

```ts
/**
 * Local write validation.
 *
 * Runs before ops are generated, so rejected data never enters the log. This
 * is what makes the schema layer convergence-safe: it is a local precondition,
 * not a filter on shared state. Remote data is never inspected here.
 */

import type { Json } from "@tangentfeed/core";
import { Field, type SchemaShape, type TableShape } from "./builders.js";

export class SchemaError extends Error {
  readonly table: string;
  readonly column: string | undefined;
  readonly expected: string;
  readonly received: string;

  constructor(init: {
    table: string;
    column?: string | undefined;
    expected: string;
    received: string;
    message: string;
  }) {
    super(init.message);
    this.name = "SchemaError";
    this.table = init.table;
    this.column = init.column;
    this.expected = init.expected;
    this.received = init.received;
  }
}

/** Human-readable type name, used for the `received` field. */
export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Checks one value against one field. Returns null when valid, or a
 * { path, expected } describing the first problem found.
 */
function checkValue(
  field: Field<unknown, boolean, boolean>,
  value: unknown,
  path: string,
): { path: string; expected: string } | null {
  if (value === null) {
    return field.isNullable ? null : { path, expected: field.kind };
  }

  switch (field.kind) {
    case "string":
    case "number":
    case "boolean": {
      if (typeof value !== field.kind) return { path, expected: field.kind };
      if (field.kind === "number" && !Number.isFinite(value)) {
        return { path, expected: "finite number" };
      }
      return null;
    }
    case "enum": {
      const allowed = field.values ?? [];
      return allowed.includes(value as string | number)
        ? null
        : { path, expected: `one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}` };
    }
    case "array": {
      if (!Array.isArray(value)) return { path, expected: "array" };
      const element = field.element;
      if (!element) return null;
      for (let i = 0; i < value.length; i++) {
        const bad = checkValue(element, value[i], `${path}[${i}]`);
        if (bad) return bad;
      }
      return null;
    }
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) return { path, expected: "object" };
      const shape = field.shape;
      if (!shape) return null;
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!(key in shape)) return { path: `${path}.${key}`, expected: "no such key" };
      }
      for (const [key, sub] of Object.entries(shape)) {
        if (!(key in record)) {
          if (sub.isOptional) continue;
          return { path: `${path}.${key}`, expected: `${sub.kind} (missing)` };
        }
        const bad = checkValue(sub, record[key], `${path}.${key}`);
        if (bad) return bad;
      }
      return null;
    }
  }
}

function tableShape(schema: SchemaShape, table: string): TableShape {
  const shape = schema[table];
  if (!shape) {
    throw new SchemaError({
      table,
      expected: `one of ${Object.keys(schema).join(", ")}`,
      received: table,
      message: `unknown table "${table}"`,
    });
  }
  return shape;
}

function checkColumns(
  shape: TableShape,
  table: string,
  values: Record<string, unknown>,
): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [column, value] of Object.entries(values)) {
    const field = shape[column];
    if (!field) {
      throw new SchemaError({
        table,
        column,
        expected: `one of ${Object.keys(shape).join(", ")}`,
        received: column,
        message: `unknown column "${column}" on table "${table}"`,
      });
    }
    const bad = checkValue(field, value, column);
    if (bad) {
      throw new SchemaError({
        table,
        column,
        expected: bad.expected,
        received: describe(value),
        message: `${table}.${bad.path}: expected ${bad.expected}, received ${describe(value)}`,
      });
    }
    out[column] = value as Json;
  }
  return out;
}

/** Full-row validation. Fills defaults and requires every non-optional field. */
export function validateInsert(
  schema: SchemaShape,
  table: string,
  values: Record<string, unknown>,
): Record<string, Json> {
  const shape = tableShape(schema, table);
  const out = checkColumns(shape, table, values);

  for (const [column, field] of Object.entries(shape)) {
    if (column in out) continue;
    if (field.hasDefault) {
      out[column] = field.defaultValue as Json;
      continue;
    }
    if (field.isOptional) continue;
    throw new SchemaError({
      table,
      column,
      expected: field.kind,
      received: "undefined",
      message: `missing required column "${column}" on table "${table}"`,
    });
  }
  return out;
}

/**
 * Partial validation. No defaults: update writes individual cells, and
 * materialising a default here would clobber a peer's value with a locally
 * invented one.
 */
export function validateUpdate(
  schema: SchemaShape,
  table: string,
  values: Record<string, unknown>,
): Record<string, Json> {
  const shape = tableShape(schema, table);
  if (Object.keys(values).length === 0) {
    throw new SchemaError({
      table,
      expected: "at least one column",
      received: "{}",
      message: `no columns to update on table "${table}"`,
    });
  }
  return checkColumns(shape, table, values);
}
```

- [ ] **Step 4: Export the new surface**

Add to `packages/schema/src/index.ts`:

```ts
export {
  SchemaError,
  validateInsert,
  validateUpdate,
} from "./validate.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @tangentfeed/schema`
Expected: PASS, all builder and validation tests.

- [ ] **Step 6: Commit**

```bash
git add packages/schema
git commit -m "feat(schema): validate local writes, fill defaults on insert only"
```

---

### Task 3: `parseRow` — opt-in read checking

The escape hatch for reading rows a peer may have written under a different schema. Returns a result rather than throwing: invalid remote data is a runtime condition to handle, not a local bug to crash on.

**Files:**
- Modify: `packages/schema/src/validate.ts`
- Modify: `packages/schema/src/index.ts`
- Test: `packages/schema/test/parse-row.test.ts`

**Interfaces:**
- Produces: `type ParseIssue = { path: string; expected: string; received: string }`; `type ParseResult<T> = { ok: true; row: T } | { ok: false; issues: ParseIssue[] }`; `parseRow(shape: TableShape, row: unknown): ParseResult<Record<string, Json> & { id: string }>`.

Unlike `validateInsert`, this collects **all** issues rather than throwing on the first, because the caller is diagnosing foreign data rather than fixing a typo.

- [ ] **Step 1: Write the failing test**

`packages/schema/test/parse-row.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @tangentfeed/schema -- parse-row`
Expected: FAIL — `parseRow` is not exported.

- [ ] **Step 3: Implement `parseRow`**

Append to `packages/schema/src/validate.ts`. It reuses `checkValue`, so extract nothing — just add below `validateUpdate`:

```ts
export interface ParseIssue {
  readonly path: string;
  readonly expected: string;
  readonly received: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly row: T }
  | { readonly ok: false; readonly issues: readonly ParseIssue[] };

/**
 * Opt-in check of a row that has already been read.
 *
 * Reads are otherwise asserted rather than proven: the inferred row type
 * describes the schema you write through, not the contents of the op log. Use
 * this on paths where a peer may have written under a different schema.
 *
 * Collects every issue rather than throwing on the first — the caller is
 * diagnosing foreign data, not fixing their own typo.
 */
export function parseRow(
  shape: TableShape,
  row: unknown,
): ParseResult<Record<string, Json> & { id: string }> {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return {
      ok: false,
      issues: [{ path: "", expected: "object", received: describe(row) }],
    };
  }

  const record = row as Record<string, unknown>;
  const issues: ParseIssue[] = [];

  for (const key of Object.keys(record)) {
    if (key === "id") continue;
    if (!(key in shape)) {
      issues.push({ path: key, expected: "no such column", received: describe(record[key]) });
    }
  }

  for (const [column, field] of Object.entries(shape)) {
    if (!(column in record)) {
      if (!field.isOptional) {
        issues.push({ path: column, expected: field.kind, received: "undefined" });
      }
      continue;
    }
    const bad = checkValue(field, record[column], column);
    if (bad) {
      issues.push({ path: bad.path, expected: bad.expected, received: describe(record[column]) });
    }
  }

  return issues.length === 0
    ? { ok: true, row: record as Record<string, Json> & { id: string } }
    : { ok: false, issues };
}
```

- [ ] **Step 4: Export it**

Add to `packages/schema/src/index.ts`:

```ts
export {
  parseRow,
  type ParseIssue,
  type ParseResult,
} from "./validate.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @tangentfeed/schema`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/schema
git commit -m "feat(schema): parseRow for opt-in checking of foreign rows"
```

---

### Task 4: Inference types

The feature itself. `types.ts` contains only types and compiles away entirely.

**Files:**
- Create: `packages/schema/src/types.ts`
- Modify: `packages/schema/src/index.ts`
- Test: `packages/schema/test/types.test-d.ts`

**Interfaces:**
- Produces: `OutOf<F>`, `RowOf<S, T>`, `InsertInput<S, T>`, `UpdateInput<S, T>`, `Infer<S>`, `TableName<S>`.

- [ ] **Step 1: Write the failing type test**

`packages/schema/test/types.test-d.ts`:

```ts
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
```

- [ ] **Step 2: Run the type test to verify it fails**

Run: `npx vitest run --typecheck packages/schema/test/types.test-d.ts`
Expected: FAIL — `Infer`, `RowOf`, `InsertInput`, `UpdateInput`, `TableName` are not exported.

- [ ] **Step 3: Enable typechecking in the package vitest config**

Replace `packages/schema/vitest.config.ts` with:

```ts
import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.js";

// `.test-d.ts` files assert on types rather than values, so the suite needs
// vitest's typecheck runner in addition to the normal one.
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      typecheck: {
        enabled: true,
        include: ["test/**/*.test-d.ts"],
      },
    },
  }),
);
```

- [ ] **Step 4: Implement the inference types**

`packages/schema/src/types.ts`:

```ts
/**
 * Inference. Types only — this module emits no runtime code.
 *
 * The split that matters: a field carries InOpt (may the key be omitted on
 * insert?) and OutOpt (may the key be absent on read?). `.default()` sets only
 * InOpt, so a defaulted column is optional going in and guaranteed coming out.
 */

import type { Field, SchemaShape, TableShape } from "./builders.js";

/** The value type a field reads back as. */
export type OutOf<F> = F extends Field<infer Out, boolean, boolean> ? Out : never;

type InOptionalKeys<T extends TableShape> = {
  [K in keyof T]: T[K] extends Field<unknown, true, boolean> ? K : never;
}[keyof T];

type InRequiredKeys<T extends TableShape> = Exclude<keyof T, InOptionalKeys<T>>;

type OutOptionalKeys<T extends TableShape> = {
  [K in keyof T]: T[K] extends Field<unknown, boolean, true> ? K : never;
}[keyof T];

type OutRequiredKeys<T extends TableShape> = Exclude<keyof T, OutOptionalKeys<T>>;

/** Flattens an intersection so editor hovers show one object. */
type Pretty<T> = { [K in keyof T]: T[K] } & {};

/** A row as read back, including the engine-assigned id. */
export type RowOf<S extends SchemaShape, T extends keyof S> = Pretty<
  { readonly id: string } & {
    [K in OutRequiredKeys<S[T]>]: OutOf<S[T][K]>;
  } & {
    [K in OutOptionalKeys<S[T]>]?: OutOf<S[T][K]>;
  }
>;

/** What `insert` accepts: defaulted and optional columns may be omitted. */
export type InsertInput<S extends SchemaShape, T extends keyof S> = Pretty<
  {
    [K in InRequiredKeys<S[T]>]: OutOf<S[T][K]>;
  } & {
    [K in InOptionalKeys<S[T]>]?: OutOf<S[T][K]>;
  }
>;

/** What `update` accepts: any subset of columns, never the id. */
export type UpdateInput<S extends SchemaShape, T extends keyof S> = Pretty<{
  [K in keyof S[T]]?: OutOf<S[T][K]>;
}>;

/** Every table name in the schema. */
export type TableName<S extends SchemaShape> = keyof S & string;

/** The whole database shape, keyed by table. */
export type Infer<S extends SchemaShape> = { [T in keyof S]: RowOf<S, T> };
```

- [ ] **Step 5: Export the types**

Add to `packages/schema/src/index.ts`:

```ts
export type {
  OutOf,
  RowOf,
  InsertInput,
  UpdateInput,
  TableName,
  Infer,
} from "./types.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w @tangentfeed/schema`
Expected: PASS, including the typecheck suite.

- [ ] **Step 7: Commit**

```bash
git add packages/schema
git commit -m "feat(schema): inference types with insert/read optionality split"
```

---

### Task 5: Wire the schema into the facade

Threads the generic through `openSpace`, validates in the two write wrappers, and keeps the no-schema call signature byte-for-byte compatible.

**Files:**
- Modify: `packages/tangentfeed/package.json` (add the dependency)
- Modify: `packages/tangentfeed/src/index.ts`
- Test: `packages/tangentfeed/test/schema.test.ts`
- Test: `packages/tangentfeed/test/schema.test-d.ts`
- Modify: `packages/tangentfeed/vitest.config.ts` (enable typecheck, same as Task 4 Step 3)

**Interfaces:**
- Consumes: `validateInsert`, `validateUpdate`, `SchemaError`, `SchemaShape`, `RowOf`, `InsertInput`, `UpdateInput`, `TableName` from `@tangentfeed/schema`.
- Produces: `OpenSpaceOptions<S>` with optional `schema?: S`; `SyncedSpace<S>` whose data methods are typed when `S` is supplied.

The backward-compatibility mechanism: `SchemaShape | undefined` defaults the generic to `undefined`, and each method's types are conditional on it. When `S` is `undefined` the conditional collapses to today's signatures, so existing callers see no change.

- [ ] **Step 1: Add the dependency**

In `packages/tangentfeed/package.json`, add to `dependencies`:

```json
    "@tangentfeed/schema": "0.1.0",
```

- [ ] **Step 2: Write the failing runtime test**

`packages/tangentfeed/test/schema.test.ts`:

```ts
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
```

- [ ] **Step 3: Write the failing type test**

`packages/tangentfeed/test/schema.test-d.ts`:

```ts
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
```

- [ ] **Step 4: Run both tests to verify they fail**

Run: `npm test -w tangentfeed -- schema`
Expected: FAIL — `schema` is not a valid option on `OpenSpaceOptions`.

- [ ] **Step 5: Enable typecheck for the facade package**

Replace `packages/tangentfeed/vitest.config.ts` with the same merged config used in Task 4 Step 3:

```ts
import { defineConfig, mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.js";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      typecheck: {
        enabled: true,
        include: ["test/**/*.test-d.ts"],
      },
    },
  }),
);
```

- [ ] **Step 6: Add the imports to the facade**

At the top of `packages/tangentfeed/src/index.ts`, alongside the existing imports:

```ts
import {
  validateInsert,
  validateUpdate,
  type SchemaShape,
  type InsertInput,
  type RowOf,
  type TableName,
  type UpdateInput,
} from "@tangentfeed/schema";
```

- [ ] **Step 7: Make the options and space generic**

In `packages/tangentfeed/src/index.ts`, change `OpenSpaceOptions` to take a generic and gain the `schema` field. Add this field to the interface and update its declaration line:

```ts
export interface OpenSpaceOptions<S extends SchemaShape | undefined = undefined> {
  // ... every existing field unchanged ...

  /**
   * Optional typed schema. Supplying one types the data methods and validates
   * local writes; it never inspects data arriving from peers, so a peer on a
   * different schema still syncs completely.
   */
  schema?: S;
}
```

Then replace the `SyncedSpace` interface's data-method block. Everything outside `// data` stays as it is:

```ts
export interface SyncedSpace<S extends SchemaShape | undefined = undefined> {
  readonly space: string;
  readonly deviceId: string;
  readonly engine: SyncEngine;

  // data
  insert: S extends SchemaShape
    ? <T extends TableName<S>>(table: T, values: InsertInput<S, T>) => Promise<string>
    : (table: string, values: Record<string, Json>) => Promise<string>;

  update: S extends SchemaShape
    ? <T extends TableName<S>>(table: T, row: string, values: UpdateInput<S, T>) => Promise<void>
    : (table: string, row: string, values: Record<string, Json>) => Promise<void>;

  delete: S extends SchemaShape
    ? (table: TableName<S>, row: string) => Promise<void>
    : (table: string, row: string) => Promise<void>;

  get: S extends SchemaShape
    ? <T extends TableName<S>>(table: T, row: string) => Promise<RowOf<S, T> | undefined>
    : (table: string, row: string) => Promise<RowData | undefined>;

  list: S extends SchemaShape
    ? <T extends TableName<S>>(table: T) => Promise<RowOf<S, T>[]>
    : (table: string) => Promise<RowData[]>;

  subscribe(cb: (event: ChangeEvent) => void): () => void;

  // ... peers/frontier/compact/close unchanged ...
}
```

- [ ] **Step 8: Make `openSpace` generic and validate in the wrappers**

Change the signature:

```ts
export async function openSpace<S extends SchemaShape | undefined = undefined>(
  opts: OpenSpaceOptions<S>,
): Promise<SyncedSpace<S>> {
```

Then replace the `insert` and `update` entries in the returned object. The rest of the return value is unchanged:

```ts
    insert: ((table: string, values: Record<string, Json>) =>
      engine.insert(
        table,
        opts.schema ? validateInsert(opts.schema, table, values) : values,
      )) as SyncedSpace<S>["insert"],

    update: ((table: string, row: string, values: Record<string, Json>) =>
      engine.update(
        table,
        row,
        opts.schema ? validateUpdate(opts.schema, table, values) : values,
      )) as SyncedSpace<S>["update"],
```

And add the matching casts to the three read methods, whose runtime behaviour does not change:

```ts
    delete: ((t: string, r: string) => engine.delete(t, r)) as SyncedSpace<S>["delete"],
    get: ((t: string, r: string) => engine.get(t, r)) as SyncedSpace<S>["get"],
    list: ((t: string) => engine.list(t)) as SyncedSpace<S>["list"],
```

Finally add the return cast at the end of the function, since the object literal is built untyped:

```ts
  } as SyncedSpace<S>;
```

The casts on the read methods are where "asserted, not proven" lives: the engine still returns `RowData`, and the schema layer relabels it without checking. That is deliberate and is why `parseRow` exists.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test -w tangentfeed`
Expected: PASS, including both new files and every pre-existing facade test.

- [ ] **Step 10: Commit**

```bash
git add packages/tangentfeed
git commit -m "feat(tangentfeed): optional typed schema on openSpace"
```

---

### Task 6: Prove the op stream is unchanged

The executable evidence that this layer cannot perturb convergence or the wire format. If this test ever fails, the schema layer has stopped being a pure local precondition.

**Files:**
- Test: `packages/tangentfeed/test/schema-op-equivalence.test.ts`

**Interfaces:**
- Consumes: `openSpace` with and without a schema; `SyncEngine.frontier()` and the `subscribe` `ChangeEvent.ops` stream.

- [ ] **Step 1: Write the test**

`packages/tangentfeed/test/schema-op-equivalence.test.ts`:

```ts
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
  ops.map((o) => ({ table: o.table, column: o.column, value: o.value })).sort((a, b) =>
    `${a.table}.${a.column}.${JSON.stringify(a.value)}`.localeCompare(
      `${b.table}.${b.column}.${JSON.stringify(b.value)}`,
    ),
  );

async function collect(useSchema: boolean) {
  const db = await openSpace(
    useSchema
      ? { space: `eq-${Math.random()}`, storage: "memory", schema }
      : { space: `eq-${Math.random()}`, storage: "memory" },
  );
  const ops: Op[] = [];
  const stop = db.subscribe((e) => ops.push(...e.ops));
  for (const row of ROWS) await (db.insert as (t: string, v: unknown) => Promise<string>)("tasks", row);
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
```

- [ ] **Step 2: Run the test**

Run: `npm test -w tangentfeed -- schema-op-equivalence`
Expected: PASS. If the first test fails, the schema layer is altering writes and the cause must be found before continuing — do not adjust the test to accommodate it.

- [ ] **Step 3: Commit**

```bash
git add packages/tangentfeed/test/schema-op-equivalence.test.ts
git commit -m "test(tangentfeed): prove the schema layer leaves the op stream unchanged"
```

---

### Task 7: Type the React hooks

**Files:**
- Modify: `packages/react/package.json` (add the dependency)
- Modify: `packages/react/src/index.ts`
- Test: `packages/react/test/hooks.test-d.ts`
- Modify: `packages/react/vitest.config.ts` (enable typecheck, same merged config as Task 4 Step 3)

**Interfaces:**
- Consumes: `SyncedSpace<S>`, `OpenSpaceOptions<S>` from `tangentfeed`; `SchemaShape`, `RowOf`, `TableName` from `@tangentfeed/schema`.
- Produces: `useSpace<S>(opts: OpenSpaceOptions<S>): SyncedSpace<S> | null`; `useRows<S, T>(db, table): { rows: RowOf<S, T>[]; loading: boolean }`.

- [ ] **Step 1: Add the dependency**

In `packages/react/package.json`, add to `dependencies`:

```json
    "@tangentfeed/schema": "0.1.0",
```

- [ ] **Step 2: Write the failing type test**

`packages/react/test/hooks.test-d.ts`:

```ts
import { describe, it, expectTypeOf } from "vitest";
import { useRows, useSpace } from "../src/index.js";
import { s, defineSchema } from "@tangentfeed/schema";
import type { SyncedSpace } from "tangentfeed";

const schema = defineSchema({ tasks: { title: s.string() } });
type S = typeof schema;

describe("typed hooks", () => {
  it("useSpace carries the schema generic through", () => {
    expectTypeOf(useSpace({ space: "x", schema })).toEqualTypeOf<SyncedSpace<S> | null>();
  });

  it("useRows infers the row type", () => {
    const db = null as unknown as SyncedSpace<S>;
    expectTypeOf(useRows(db, "tasks").rows).toEqualTypeOf<{ id: string; title: string }[]>();
  });

  it("still works untyped", () => {
    const db = null as unknown as SyncedSpace;
    expectTypeOf(useRows(db, "anything").rows).toBeArray();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w @tangentfeed/react`
Expected: FAIL — `useSpace` is not generic.

- [ ] **Step 4: Make the hooks generic**

In `packages/react/src/index.ts`, add to the imports:

```ts
import type { SchemaShape, RowOf, TableName } from "@tangentfeed/schema";
```

Replace the `useSpace` signature (the body is unchanged):

```ts
export function useSpace<S extends SchemaShape | undefined = undefined>(
  opts: OpenSpaceOptions<S>,
): SyncedSpace<S> | null {
```

Inside the body, the two `useState`/local annotations must widen to match:

```ts
  const [db, setDb] = useState<SyncedSpace<S> | null>(null);
  // ...
    let opened: SyncedSpace<S> | null = null;
```

Replace the `useRows` signature. Its body is unchanged apart from the state type:

```ts
export function useRows<
  S extends SchemaShape | undefined = undefined,
  T extends (S extends SchemaShape ? TableName<S> : string) = never,
>(
  db: SyncedSpace<S> | null,
  table: T,
): { rows: S extends SchemaShape ? RowOf<S, T & keyof S>[] : RowData[]; loading: boolean } {
```

and inside, change the state declaration to:

```ts
  const [rows, setRows] = useState<RowData[]>([]);
```

returning it with a cast at the end of the hook:

```ts
  return { rows: rows as never, loading };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @tangentfeed/react`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/react
git commit -m "feat(react): thread the schema generic through useSpace and useRows"
```

---

### Task 8: Documentation

**Files:**
- Create: `packages/schema/README.md`
- Modify: `README.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Write the package README**

`packages/schema/README.md`:

````markdown
# @tangentfeed/schema

A typed schema for tangentfeed: infers TypeScript types from one declaration
and validates local writes. Zero runtime dependencies.

```ts
import { openSpace } from "tangentfeed";
import { s, defineSchema } from "@tangentfeed/schema";

const schema = defineSchema({
  tasks: {
    title:    s.string(),
    done:     s.boolean().default(false),
    priority: s.number().optional(),
    tags:     s.array(s.string()).default([]),
  },
});

const db = await openSpace({ space: "kitchen-42", schema });

await db.insert("tasks", { title: "Oat milk" });   // done and tags defaulted
await db.insert("tasks", { titel: "typo" });       // compile error + throws

const rows = await db.list("tasks");
//    ^? { id: string; title: string; done: boolean;
//         priority?: number; tags: string[] }[]
```

## What it validates

Local writes only, in `insert` and `update`, before ops are generated.
Unknown tables, unknown columns, type mismatches and missing required fields
throw a `SchemaError` carrying `table`, `column`, `expected` and `received`.

**Data arriving from peers is never inspected.** Validation is a local
precondition — rejected data never becomes an op — so a peer running a
different schema still syncs with you completely. Filtering reads through a
local schema would make visible state depend on schema version, which would
break convergence.

## Reads are asserted, not proven

`list("tasks")` returns `Task[]` because that is the schema you write through,
not because anything checked the op log. A peer on an older schema may have
written a number where you expect a string, and nothing here will catch it.

Where that matters, check explicitly:

```ts
import { parseRow } from "@tangentfeed/schema";

const row = await db.get("tasks", id);
const checked = parseRow(schema.tasks, row);
if (!checked.ok) console.warn(checked.issues);
```

`parseRow` returns a result rather than throwing, and reports every issue
rather than only the first.

## Field types

`s.string()`, `s.number()`, `s.boolean()`, `s.array(field)`, `s.object(shape)`,
`s.enum(...values)` — each with `.optional()`, `.nullable()` and
`.default(value)`.

`.optional()` makes a column omissible on insert and possibly absent on read.
`.default(v)` makes it omissible on insert but always present on read, because
the default is written as a real cell. `.nullable()` widens the value, not the
presence — `Json` allows `null` everywhere, so the DSL makes you say when it is
meaningful.

`s.object(...)` validates its interior but is **one cell**: cell-level LWW
merges it atomically. Nesting is storage, not structure.

`update` never applies defaults — it writes individual cells, and inventing a
default there would clobber a peer's value.

## Not included

Migrations and schema versioning, read validation, relations, indexes, and
bring-your-own-validator interop. Versioning a schema while peers still hold
rows written under an older one is a hard distributed problem and is
deliberately out of scope.
````

- [ ] **Step 2: Update the root README**

In `README.md`, the `## Status` section currently reads:

```
Planned, currently out of scope: a typed schema layer, store-and-forward
mailboxes for peers that are never online simultaneously, React Native
adapters, a Rust core with FFI bindings, and rich CRDT value types
(collaborative text, ordered lists).
```

Replace with:

```
Planned, currently out of scope: store-and-forward mailboxes for peers that
are never online simultaneously, React Native adapters, a Rust core with FFI
bindings, and rich CRDT value types (collaborative text, ordered lists).
```

Then add a new section immediately before `## Development`:

```markdown
## Typed schemas

`@tangentfeed/schema` infers TypeScript types from a schema and validates local
writes:

    import { s, defineSchema } from "@tangentfeed/schema";

    const schema = defineSchema({
      tasks: { title: s.string(), done: s.boolean().default(false) },
    });

    const db = await openSpace({ space: "kitchen-42", schema });
    const rows = await db.list("tasks");   // { id, title, done }[]

Validation covers local writes only; data from peers is never inspected, so a
peer on a different schema still syncs. That also means read types are an
assertion about the schema you write through rather than a guarantee about the
op log — use `parseRow` where that distinction matters. See
[packages/schema](./packages/schema/README.md).
```

- [ ] **Step 3: Add the ROADMAP entry**

In `ROADMAP.md`, under `## Post-v0.1`, append:

```markdown
- [x] Typed schema layer (`@tangentfeed/schema`): field DSL with inference,
  local write validation with defaults, `parseRow` for opt-in checking of
  foreign rows; zero runtime dependencies, core untouched. Includes an
  op-stream equivalence test proving the layer cannot perturb the wire format.
```

- [ ] **Step 4: Verify the full suite and build**

Run: `npm test`
Expected: PASS across all packages.

Run: `npm run build`
Expected: every package builds, including `@tangentfeed/schema`.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/README.md README.md ROADMAP.md
git commit -m "docs(schema): package README, root README section, roadmap entry"
```

---

## Self-review notes

**Spec coverage.** Boundary → Tasks 2 and 5. DSL and field types → Task 1.
Insert/output optionality split → Tasks 1 and 4. Flat-per-column objects →
Task 1 Step 7 and Task 8. Validation semantics table → Task 2. Throw vs
`onError` → Task 2. `null` requires `.nullable()` → Tasks 1, 2, 4. Reads
asserted not proven → Task 5 Step 8 and Task 8. `parseRow` → Task 3.
Inference surface → Task 4. `subscribe` table narrowing → **not implemented**;
see the note below. Backward compatibility → Task 5. Package layout → Task 1.
All four test categories → Tasks 2, 4, 6, and Task 5 Step 2. Non-goals →
Task 8. Docs → Task 8.

**Deviation from the spec, deliberate.** The spec lists narrowing
`subscribe`'s `change.table` to `keyof S`. That would require a generic
`ChangeEvent<S>` in `@tangentfeed/core`, and the Global Constraints forbid
modifying core. The alternative — redeclaring the event type in the facade —
buys a narrowed string on a callback that already has to handle remote changes
for tables the local schema may not know about, which is exactly where a
narrowed type would be wrong. Dropped rather than worked around; raise it if
you disagree.

**Type consistency.** `Field<Out, InOpt, OutOpt>` and the flags `isOptional` /
`isNullable` / `hasDefault` are used identically in Tasks 1–4. The data flags
are deliberately named `isOptional`/`isNullable` because `optional()` and
`nullable()` are method names on the same class. `validateInsert` /
`validateUpdate` / `parseRow` / `SchemaError` signatures match between Tasks 2,
3 and 5. `RowOf` / `InsertInput` / `UpdateInput` / `TableName` match between
Tasks 4, 5 and 7.
