# tangentfeed

Offline-first, peer-to-peer data sync.

A local database that keeps working with no network and converges with your
other devices whenever they can reach each other. No server owns the data, and
no server has to be reachable for the app to work.

```bash
npm install tangentfeed
```

## Use

```ts
import { openSpace, broadcast } from "tangentfeed";

const db = await openSpace({
  space: "kitchen-42",
  transports: [broadcast()],   // syncs across tabs on this device
});

const id = await db.insert("tasks", { title: "Buy oat milk", done: false });

await db.update("tasks", id, { done: true });   // one operation per column
await db.delete("tasks", id);                   // writes a tombstone

const rows = await db.list("tasks");
db.subscribe(async () => render(await db.list("tasks")));
```

Values are any JSON. There is no schema and no migration step: a column exists
once something writes to it. Storage defaults to IndexedDB in browsers and
memory elsewhere.

## How conflicts resolve

The unit of conflict is a **cell** — one column of one row — not the row. Two
devices editing different columns of the same task both win. Two devices
editing the *same* column resolve by hybrid logical clock, deterministically,
so every replica picks the same winner without asking a server.

Writes made offline are queued and merge on reconnect. Delivery order,
duplication and batching cannot change the result.

## Syncing across devices

```ts
import { openSpace, webrtc } from "tangentfeed";

const db = await openSpace({
  space: "kitchen-42",
  transports: [webrtc({ signaling: "wss://your-relay.example.com" })],
  encryption: { passphrase: "correct horse battery staple" },
});
```

The signaling relay only introduces peers; your data never passes through it,
and with `encryption` set it could not read it anyway. Run one with
`npx @tangentfeed/signaling-server`.

## Typed schemas

Optional. Infers TypeScript types from one declaration and validates local
writes:

```ts
import { s, defineSchema } from "@tangentfeed/schema";

const schema = defineSchema({
  tasks: { title: s.string(), done: s.boolean().default(false) },
});

const db = await openSpace({ space: "kitchen-42", schema });
const rows = await db.list("tasks");   // { id, title, done }[]
```

## Related packages

| Package | For |
|---|---|
| `@tangentfeed/react` | `useSpace`, `useRows`, `useTable` hooks |
| `@tangentfeed/adapter-sqlite` | Node, Electron or Bun instead of a browser |
| `@tangentfeed/signaling-server` | Running the relay yourself |
| `@tangentfeed/core` | Building against the protocol directly |

## Before you rely on it

**Anyone who learns a space name can delete everything in that space.**

Operations are signed, so they cannot be forged and a device cannot be
impersonated — but a signature proves *who* wrote an op, not that they were
*allowed* to. There is no membership model yet, so any peer that reaches your
signaling server and knows the space name can join it. Encryption does not
close this: row tombstones are deliberately plaintext so that keyless relays
can order deletes, which means a peer with no key still cannot read your data
but can delete it.

Treat a space name as a secret: high-entropy, never in a URL or a public build,
and keep your signaling server private. The relay has no authentication, rate
limiting or payload cap, so it is not safe to expose to the open internet as it
stands.

Cross-network sync is also unproven — every test so far had both peers on one
local network, and traversing NAT generally needs a TURN relay.

This is v0.2 and pre-1.0. The wire format is not frozen; v0.2 already broke
compatibility with v0.1.

## Documentation

- [Guide and API reference](https://tangentfeed.com)
- [Protocol specification](https://github.com/Sreerajta/tangentfeed/blob/main/PROTOCOL.md) — the product; the code is commentary
- [Conformance vectors](https://github.com/Sreerajta/tangentfeed/tree/main/conformance) — language-neutral, what any implementation must pass
- [Source](https://github.com/Sreerajta/tangentfeed)

MIT licensed.
