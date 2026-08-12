# Typed schema layer with inference

**Status:** approved design, not yet implemented
**Date:** 2026-08-12
**Package:** `@tangentfeed/schema` (new), with changes to `tangentfeed` and `@tangentfeed/react`

## Problem

The data API is untyped. `insert(table: string, values: Record<string, Json>)`
accepts any table name and any shape, and `RowData` is
`{ id: string } & Record<string, Json>`, so reads carry no information about
what a row contains. Table names are strings, so typos compile.

This is worse here than in a server-backed store. Data written offline persists
locally and replicates to every peer, permanently. A misspelled column is not a
failed request — it is a new column, synced to every device, indistinguishable
from an intentional one.

The README lists "a typed schema layer" as planned and out of scope for v0.1.
This spec covers it.

## Boundary

**Validate local writes. Infer types everywhere. Never inspect remote data.**

Validation runs in the facade before ops are generated. Rejected data never
becomes an op, so this cannot affect convergence: a peer running an older or
newer schema still syncs completely, and the only thing a schema prevents is
*you* authoring rows *you* consider invalid.

Two alternatives were rejected:

- **Types only, no runtime checks.** The data that actually corrupts a store
  arrives from JSON payloads, form inputs, `any` at a boundary, or a `catch`
  block writing an error object — none of which compile-time types constrain.
  A schema that cannot be enforced at the write boundary is documentation.

- **Validating reads as well.** `PROTOCOL.md` is the product and core merges
  every valid op unconditionally. If reads were filtered through a local
  schema, two peers with different schema versions would render different
  state from an identical op log. That breaks convergence, the central
  guarantee. It is a protocol change and must not arrive as a side effect of
  adding types.

## Usage

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

await db.insert("tasks", { title: "Oat milk" });
await db.insert("tasks", { titel: "typo" });   // compile error + throws
await db.insert("taskz", {});                  // unknown table

const rows = await db.list("tasks");
//    ^? { id: string; title: string; done: boolean;
//         priority?: number; tags: string[] }[]

await db.update("tasks", id, { done: true });  // partial
```

### Insert input differs from row output

Fields with `default()` or `optional()` are optional on the way in and present
on the way out (`optional()` fields as `?:`). Deriving both from one
declaration is the work inference has to earn.

### `update` is partial by construction

It mirrors the engine, which writes individual cells rather than whole rows.

### Schemas are flat per column

Cell-level LWW makes each column an independently merged unit. `s.object(...)`
is therefore a single opaque cell that merges atomically — nesting is storage,
not structure. The DSL must not imply field-level merge inside an object.

## Field types

`s.string()`, `s.number()`, `s.boolean()`, `s.array(field)`, `s.object(shape)`,
`s.enum(...values)`, each with `.optional()`, `.nullable()`, and
`.default(value)`.

`s.object(shape)` validates its interior and infers a nested type, but remains
one cell: validation depth and merge granularity are separate concerns. Nothing
in the DSL may introduce field-level merging inside an object — see "Schemas
are flat per column".

`null` requires `.nullable()` explicitly. `Json` permits `null` everywhere, but
"absent" and "legitimately null" are different claims and the DSL should make
you state which.

## Validation semantics

Runs in the facade's `insert`/`update` wrappers before reaching the engine.

| Condition | Result |
|---|---|
| Unknown table | `SchemaError` |
| Unknown column | `SchemaError` (strict — catching typos is the point) |
| Type mismatch | `SchemaError` with table, column, expected, received |
| Missing required field (no default, not optional) | `SchemaError` |
| `default()` field absent | filled in, **on `insert` only** |

`update` never applies defaults. It is a partial write of individual cells, and
materialising a default there would clobber a peer's value with a locally
invented one.

Violations **throw**, matching `BadOpError`. `onError` remains a channel for
protocol-level trouble (clock drift, bad remote ops); a schema violation is a
local bug and should be loud and synchronous.

## Reads are asserted, not proven

`list("tasks")` returns `Task[]` as an assertion. TypeScript will insist
`row.title` is a `string`; a peer on an older schema may have written a number,
and nothing checks. **The types describe the schema you write through, not the
contents of the op log.** This follows directly from not validating reads, and
must be stated plainly in the README rather than discovered.

One opt-in escape hatch, for paths where remote data is actually suspect:

```ts
import { parseRow } from "@tangentfeed/schema";

const row = await db.get("tasks", id);
const checked = parseRow(schema.tasks, row);
if (!checked.ok) console.warn(checked.issues);
```

Returns a result rather than throwing: unlike a local write, invalid remote
data is a runtime condition to handle, not a bug to crash on.

## Inference surface

- `Infer<typeof schema>` — the whole database shape
- `RowOf<S, T>` — a read row, including `id: string`
- `InsertInput<S, T>` — defaults and optionals made optional
- `subscribe` narrows `change.table` to `keyof S & string`

## Backward compatibility

`schema` is optional. Without it `openSpace` keeps today's exact untyped
signature. v0.1 is published, so this is strictly additive and existing code
compiles unchanged. Implemented with overloads on `openSpace` and a generic
`SyncedSpace<S>` that degrades to today's types when `S` is absent.

## Package layout

```
packages/schema/
  src/
    index.ts      public exports
    builders.ts   the `s` DSL
    types.ts      Infer, RowOf, InsertInput — inference only
    validate.ts   runtime checks, SchemaError, parseRow
  test/
    validate.test.ts
    types.test-d.ts
```

`types.ts` compiles away entirely; `validate.ts` is the only executable output.
Keeping them separate makes it obvious which is which and lets the types be
audited without reading validation logic.

Zero runtime dependencies, consistent with the rest of the project.

**Also changed:** `packages/tangentfeed` (generic `openSpace`/`SyncedSpace`,
two validation wrappers), `packages/react` (generic `useSpace`/`useRows`).
**Unchanged:** `packages/core`.

## Testing

Vitest is already present in every package and ships `expectTypeOf`, so
type-level tests add no dependency.

1. **Runtime validation** — every field type accepted and rejected; defaults
   applied on `insert` and not on `update`; `optional` vs `nullable`; unknown
   table and column; `SchemaError` carries correct table, column, expected,
   received.
2. **Type-level** (`expectTypeOf`) — defaulted fields optional on input and
   present on output; unknown table names rejected; `update` accepts partials;
   `subscribe` narrows `table`. Inference is the feature, so it needs
   assertions rather than merely compiling.
3. **Op-stream equivalence** — for input where every defaulted field is
   supplied explicitly, ops emitted through a schema-wrapped space are
   byte-identical to those from an unwrapped one. This is the executable proof
   that the layer is a pure local precondition and cannot perturb the wire
   format or convergence. The existing conformance vectors run a second pass
   through a schema-wrapped space.
4. **Backward compatibility** — a no-schema `openSpace` call typechecks and
   behaves exactly as today.

## Non-goals

Migrations and schema versioning; read validation; relations and foreign keys;
indexes or a query language; Standard Schema interop (bring-your-own Zod).

The last is the most tempting and the easiest to add once the field descriptors
have settled. Designing for that compatibility surface now would mean fixing
our own shape around someone else's before knowing what it wants to be.

Migrations are excluded deliberately: versioning a schema while peers still
hold rows written under an older one is a hard distributed problem, and folding
it in here would swallow the feature.

## Docs

Package README; a section in the root README including the "asserted, not
proven" caveat; a ROADMAP entry; and the root README's
`Planned, currently out of scope: a typed schema layer` line updated, since it
would no longer be true.
