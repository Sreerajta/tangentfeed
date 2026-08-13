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

That property is enforced by a test: for input where every defaulted column is
supplied explicitly, the ops emitted through a schema-wrapped space are
identical to those from an unwrapped one.

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

## React

The hooks in `@tangentfeed/react` are generic over the schema, so types carry
through:

```ts
const db = useSpace({ space: "kitchen-42", schema });
const { rows } = useRows(db, "tasks");        // Task[]
const { insert } = useTable(db, "tasks");     // insert({ title: string, done?: boolean })
```

## Not included

Migrations and schema versioning, read validation, relations, indexes, and
bring-your-own-validator interop. Versioning a schema while peers still hold
rows written under an older one is a hard distributed problem and is
deliberately out of scope.
