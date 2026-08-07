# @tangentfeed/adapter-sqlite

SQLite storage adapter for [tangentfeed](https://github.com/sreerajta/tangentfeed). Runs
on Node, Electron, Bun, and React Native — your synced data becomes a real
SQLite database you can open with any client.

```ts
import Database from "better-sqlite3";
import { SqliteAdapter, betterSqliteDriver } from "@tangentfeed/adapter-sqlite";
import { SyncEngine } from "@tangentfeed/core";

const storage = SqliteAdapter.open(betterSqliteDriver(new Database("tasks.db")));
const engine = await SyncEngine.open({ deviceId, storage });
```

## Drivers

The adapter targets a four-method interface, so the SQLite binding is your
choice:

```ts
betterSqliteDriver(new Database("tasks.db"))          // better-sqlite3
nodeSqliteDriver(new DatabaseSync("tasks.db"))        // node:sqlite (Node 22+)
```

Bun's `bun:sqlite` and `expo-sqlite` fit the same shape; wrap them with a small
object exposing `exec`, `prepare`, and optionally `close`.

## Schema

| Table | Contents |
|---|---|
| `ops` | The operation log. `id` is the HLC string, so PRIMARY KEY order is causal order. Indexed on `(device, hlc)` for frontier diffs |
| `cells` | Materialized state: winning op per `(table_name, row_id, column_name)` |
| `meta` | Frontier, persisted clock, recorded peer frontiers |

Both data tables are `WITHOUT ROWID`, since their primary keys are the natural
access paths.

```bash
sqlite3 tasks.db "SELECT table_name, column_name, value FROM ops ORDER BY id;"
```

Writes run inside `BEGIN IMMEDIATE` transactions, satisfying the all-or-nothing
requirement in PROTOCOL.md §8.2.

Part of [tangentfeed](https://github.com/sreerajta/tangentfeed). MIT licensed.
