/**
 * Operation format and validation — PROTOCOL.md §3, §11.
 */

import { decodeHlc } from "./hlc.js";

/** JSON-representable value. */
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [k: string]: Json };

export const TOMBSTONE_COLUMN = "-";

export interface Op {
  readonly id: string; // === hlc in v0.1
  readonly table: string;
  readonly row: string; // ULID
  readonly column: string; // name or "-"
  readonly value: Json;
  readonly hlc: string;
  readonly device: string;
}

/** deviceId → highest HLC string seen from that device. §6 step 2. */
export type Frontier = Readonly<Record<string, string>>;

export class BadOpError extends Error {
  readonly code = "BAD_OP";
  constructor(msg: string) {
    super(`BAD_OP: ${msg}`);
  }
}

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
export const MAX_OP_BYTES = 64 * 1024;
export const MAX_BATCH_OPS = 1000;

/** Validate an op's shape. Throws BadOpError. §11. */
export function validateOp(op: unknown): asserts op is Op {
  if (typeof op !== "object" || op === null) throw new BadOpError("not an object");
  const o = op as Record<string, unknown>;
  for (const f of ["id", "table", "row", "column", "hlc", "device"]) {
    if (typeof o[f] !== "string") throw new BadOpError(`field ${f} must be a string`);
  }
  if (!("value" in o)) throw new BadOpError("missing value");
  const { id, table, row, column, hlc, device } = o as unknown as Op;

  let decoded;
  try {
    decoded = decodeHlc(hlc);
  } catch {
    throw new BadOpError(`malformed hlc: ${hlc}`);
  }
  if (id !== hlc) throw new BadOpError("id must equal hlc in v0.1");
  if (device !== decoded.deviceId) throw new BadOpError("device does not match hlc suffix");
  if (!NAME_RE.test(table)) throw new BadOpError(`bad table name: ${table}`);
  if (column !== TOMBSTONE_COLUMN && !NAME_RE.test(column)) {
    throw new BadOpError(`bad column name: ${column}`);
  }
  if (!ULID_RE.test(row)) throw new BadOpError(`row is not a ULID: ${row}`);
  assertJson(o["value"], "value");
  if (JSON.stringify(op).length > MAX_OP_BYTES) throw new BadOpError("op exceeds 64 KiB");
}

function assertJson(v: unknown, path: string): asserts v is Json {
  switch (typeof v) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (!Number.isFinite(v)) throw new BadOpError(`${path}: non-finite number`);
      return;
    case "object": {
      if (v === null) return;
      if (Array.isArray(v)) {
        v.forEach((x, i) => assertJson(x, `${path}[${i}]`));
        return;
      }
      for (const [k, x] of Object.entries(v)) assertJson(x, `${path}.${k}`);
      return;
    }
    default:
      throw new BadOpError(`${path}: unsupported type ${typeof v}`);
  }
}

/** Is `op` above `frontier` (i.e., not yet seen by its holder)? */
export function aboveFrontier(op: Op, frontier: Frontier): boolean {
  const seen = frontier[op.device];
  return seen === undefined || op.hlc > seen; // string compare === HLC order, §4.2
}

/** Merge an op's hlc into a frontier, returning the (possibly new) frontier. */
export function advanceFrontier(frontier: Frontier, op: Op): Frontier {
  const seen = frontier[op.device];
  if (seen !== undefined && seen >= op.hlc) return frontier;
  return { ...frontier, [op.device]: op.hlc };
}
