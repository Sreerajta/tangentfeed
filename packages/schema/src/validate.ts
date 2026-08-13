/**
 * Local write validation.
 *
 * Runs before ops are generated, so rejected data never enters the log. This
 * is what makes the schema layer convergence-safe: it is a local precondition,
 * not a filter on shared state. Remote data is never inspected here.
 */

import type { Json } from "@tangentfeed/core";
import type { AnyField, SchemaShape, TableShape } from "./builders.js";

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
  field: AnyField,
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
