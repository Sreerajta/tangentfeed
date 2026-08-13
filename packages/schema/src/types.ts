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
  { id: string } & {
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
