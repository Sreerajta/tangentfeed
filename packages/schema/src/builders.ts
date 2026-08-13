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

interface FieldInit {
  kind: FieldKind;
  isOptional?: boolean;
  isNullable?: boolean;
  hasDefault?: boolean;
  defaultValue?: Json | undefined;
  element?: AnyField | undefined;
  shape?: Record<string, AnyField> | undefined;
  values?: readonly (string | number)[] | undefined;
}

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
  readonly element: AnyField | undefined;
  readonly shape: Record<string, AnyField> | undefined;
  readonly values: readonly (string | number)[] | undefined;

  // Phantom carriers. `declare` means no runtime property is emitted.
  declare readonly __out?: Out;
  declare readonly __inOpt?: InOpt;
  declare readonly __outOpt?: OutOpt;

  constructor(init: FieldInit) {
    this.kind = init.kind;
    this.isOptional = init.isOptional ?? false;
    this.isNullable = init.isNullable ?? false;
    this.hasDefault = init.hasDefault ?? false;
    this.defaultValue = init.defaultValue;
    this.element = init.element;
    this.shape = init.shape;
    this.values = init.values;
  }

  private clone(patch: Partial<FieldInit>): Field<never, never, never> {
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
    }) as Field<never, never, never>;
  }

  /** Key may be omitted on insert, and may be absent when read. */
  optional(): Field<Out, true, true> {
    return this.clone({ isOptional: true }) as unknown as Field<Out, true, true>;
  }

  /** Value may be null. Independent of presence. */
  nullable(): Field<Out | null, InOpt, OutOpt> {
    return this.clone({ isNullable: true }) as unknown as Field<Out | null, InOpt, OutOpt>;
  }

  /** Key may be omitted on insert; the default is written, so reads always see it. */
  default(value: Out & Json): Field<Out, true, OutOpt> {
    return this.clone({
      hasDefault: true,
      defaultValue: value,
    }) as unknown as Field<Out, true, OutOpt>;
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
