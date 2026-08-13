# TangentFeed

**Offline-first, peer-to-peer data sync. Any storage, any transport, any language.**

Your app reads and writes a local database with zero latency, online or off.
Devices converge whenever any transport connects them — over the local network,
across the internet, or by scanning a QR code with no server at all.

```bash
npm install tangentfeed
```

```ts
import { openSpace, broadcast, webrtc } from "tangentfeed";

const db = await openSpace({
  space: "kitchen-42",
  transports: [broadcast(), webrtc({ signaling: "wss://sync.example.com" })],
  encryption: { passphrase: "correct horse battery staple" },
});

const id = await db.insert("tasks", { title: "Buy oat milk", done: false });
await db.update("tasks", id, { done: true });

db.subscribe(async () => render(await db.list("tasks")));
```

That is the whole API for most apps. Reads are local. Writes are local. Sync
happens in the background and never blocks anything.

---

## Why another sync library

Most options make you adopt a mothership: a Postgres you must run, a hosted
backend that can read your data, or a framework that owns your data layer.
tangentfeed is a **protocol first** and a TypeScript library second:

- **No server required.** Two devices can pair by QR code and sync with no
  infrastructure at all. Add a relay only if you want sync while devices sleep.
- **Zero-knowledge by design.** With encryption on, signaling servers and
  relays move ciphertext they cannot read.
- **Storage-agnostic.** IndexedDB in browsers, SQLite on servers and desktop —
  same protocol, same guarantees. LMDB, MMKV, or a flat file fit the same small
  interface.
- **Cell-level merge.** Two devices editing different fields of the same row
  both keep their edit. No lost updates, no manual conflict resolution.
- **Implementable elsewhere.** [`PROTOCOL.md`](./PROTOCOL.md) fully specifies
  the format and rules, and [`/conformance`](./conformance) holds
  language-neutral test vectors so a Rust or Dart client can prove itself.

## How it works

Every write becomes an immutable **operation** on one cell
`(table, row, column)`, stamped with a Hybrid Logical Clock so all devices
agree on ordering even when their wall clocks disagree. Merging is
last-writer-wins **per cell**, which is commutative, associative, and
idempotent — so operations can arrive in any order, duplicated or delayed, and
every replica still lands on identical state. The tables you read are a cache
materialized from that log.

That property is what lets the transport layer stay dumb: it only has to move
opaque messages, and may lose, duplicate, or reorder them freely.

## Packages

| Package | Purpose |
|---|---|
| `tangentfeed` | Batteries-included entry point (`openSpace`) |
| `@tangentfeed/core` | Protocol engine: HLC, oplog, merge, replication. **Zero dependencies** |
| `@tangentfeed/adapter-idb` | IndexedDB storage (browsers) |
| `@tangentfeed/adapter-sqlite` | SQLite storage (Node, Electron, Bun, React Native) |
| `@tangentfeed/crypto` | End-to-end encryption (XChaCha20-Poly1305) |
| `@tangentfeed/transport-broadcast` | Same-device tabs and workers |
| `@tangentfeed/transport-webrtc` | Cross-device WebRTC + serverless QR pairing |
| `@tangentfeed/signaling-server` | Blind signaling relay (~120 lines) |
| `@tangentfeed/schema` | Typed schema: inference + local write validation. **Zero dependencies** |
| `@tangentfeed/react` | React hooks |

## React

```tsx
import { useSpace, useRows, useTable } from "@tangentfeed/react";
import { broadcast } from "tangentfeed";

function Tasks() {
  const db = useSpace({ space: "kitchen-42", transports: [broadcast()] });
  const { rows, loading } = useRows(db, "tasks");
  const { insert, update } = useTable(db, "tasks");

  if (loading) return <p>Loading…</p>;
  return (
    <ul>
      {rows.map((t) => (
        <li key={t.id}>
          <input
            type="checkbox"
            checked={t.done === true}
            onChange={(e) => update(t.id, { done: e.target.checked })}
          />
          {String(t.title)}
        </li>
      ))}
    </ul>
  );
}
```

## Transports

Pick any combination; they run concurrently and the engine deduplicates.

```ts
broadcast()                              // tabs & workers, same device
webrtc({ signaling: "wss://…" })         // cross-device, NAT traversal
existing(pairedTransport)                // QR-paired, no server at all
```

Run your own signaling server (it never sees your data):

```bash
npx @tangentfeed/signaling-server        # listens on :8787
```

## Encryption

```ts
encryption: { passphrase: "…" }      // scrypt-derived, salted by space id
encryption: { secret: someBytes }    // or supply 32 raw bytes
```

Cell values are encrypted with XChaCha20-Poly1305 before they enter the log, so
storage, transports, and relays only ever hold ciphertext. Table, row, and
column names remain visible in v1 — see PROTOCOL.md §7.2 for the precise threat
model.

## Storage growth

The op log is compacted against a safety horizon derived from what every known
peer has acknowledged:

```ts
const stats = await db.compact();
// { removed: 10000, rowsReclaimed: 0, blockedBy: [] }
```

Superseded operations are reclaimed once every peer has seen them. Deleted rows
are reclaimed only with `includeTombstones: true`, and only when provably safe.
See PROTOCOL.md §9.

## SQLite

On Node, Electron, or Bun, back a space with a real database file:

```ts
import Database from "better-sqlite3";
import { SqliteAdapter, betterSqliteDriver } from "@tangentfeed/adapter-sqlite";

const db = await openSpace({
  space: "kitchen-42",
  storage: SqliteAdapter.open(betterSqliteDriver(new Database("tasks.db"))),
  transports: [webrtc({ signaling: "ws://localhost:8787" })],
});
```

The result is an ordinary SQLite file, queryable while the app runs:

```bash
sqlite3 tasks.db "SELECT table_name, column_name, value FROM ops ORDER BY id;"
```

This is also how you run an always-on peer: a small Node process holding a
replica so devices can sync even when they are never online at the same time.
See `apps/node-demo`.

## Site and documentation

The landing page and full documentation live in `site/`, built to static files:

```bash
npm run site      # → site/dist
```

The landing page hero runs two real replicas in the browser, bundled from this
workspace, so the demo cannot drift from the library. Deploy configs for GitHub
Pages and Netlify are included.

## Demos

```bash
npm install && npm run build
cd apps/demo && npm run build
python3 -m http.server 8000 --directory dist
```

- `index.html` — two tabs, one device, live sync over BroadcastChannel
- `webrtc.html` — laptop ↔ phone across the network (start the signaling server first)
- `manual.html` — QR pairing with **no server and no internet**

Each demo is built on the public `tangentfeed` API, so they double as worked
examples.

## Status

v0.1. The protocol is stable enough to build on and the conformance vectors pin
down its behaviour, but it is pre-1.0: expect refinement before the format is
frozen. See [ROADMAP.md](./ROADMAP.md) for what shipped and when.

Planned, currently out of scope: store-and-forward mailboxes for peers that
are never online simultaneously, React Native adapters, a Rust core with FFI
bindings, and rich CRDT value types (collaborative text, ordered lists).

## Typed schemas

`@tangentfeed/schema` infers TypeScript types from a schema and validates local
writes:

```ts
import { s, defineSchema } from "@tangentfeed/schema";

const schema = defineSchema({
  tasks: { title: s.string(), done: s.boolean().default(false) },
});

const db = await openSpace({ space: "kitchen-42", schema });
const rows = await db.list("tasks");   // { id, title, done }[]
```

Validation covers local writes only; data from peers is never inspected, so a
peer on a different schema still syncs. That also means read types are an
assertion about the schema you write through rather than a guarantee about the
op log — use `parseRow` where that distinction matters. See
[packages/schema](./packages/schema/README.md).

## Development

```bash
npm install
npm test          # 195 tests across 9 packages
npm run build     # every package, with type declarations
```

## License

MIT
