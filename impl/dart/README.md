# tangentfeed

Offline-first, peer-to-peer data sync for Dart and Flutter.

A local database that keeps working with no network and converges with your
other devices whenever they can reach each other. No server owns the data, and
no server has to be reachable for the app to work.

This is a second implementation of the [tangentfeed
protocol](https://github.com/Sreerajta/tangentfeed/blob/main/PROTOCOL.md),
validated by the same conformance vectors as the TypeScript one, so a Dart peer
and a browser peer sync with each other.

Zero runtime dependencies.

## Install

```yaml
dependencies:
  tangentfeed:
    git:
      url: https://github.com/Sreerajta/tangentfeed.git
      path: impl/dart
```

For Flutter apps, add [`tangentfeed_flutter`](../flutter) too — it supplies
sqflite storage and a WebRTC transport.

## Use

```dart
import 'package:tangentfeed/tangentfeed.dart';

final db = await openSpace(
  space: 'kitchen-42',
  storage: MemoryAdapter(),
);

final id = await db.insert('tasks', {'title': 'Buy oat milk', 'done': false});

await db.update('tasks', id, {'done': true});   // one operation per column
await db.delete('tasks', id);                    // writes a tombstone

final rows = await db.list('tasks');
db.subscribe((event) async => print(await db.list('tasks')));
```

Values are any JSON. There is no schema and no migration step: a column exists
once something writes to it.

### Syncing

Pass transports. Everything else is automatic — catch-up on connect, live tail
after that, and a re-sync on every reconnect.

```dart
final db = await openSpace(
  space: 'kitchen-42',
  storage: await SqliteAdapter.open(myDriver),
  transports: [
    ({required space, required deviceId}) async {
      final t = MyTransport(space: space, deviceId: deviceId);
      await t.start();
      return t;
    },
  ],
);
```

A transport is any bidirectional message channel; see `Transport`.
`LoopbackTransport` is an in-process one, useful for tests.

### Identity

You will notice `openSpace` takes no deviceId. That is deliberate.

Section 4.3 of the protocol requires a replica identity generated once and then
persisted. Minting a fresh one per launch still converges, so nothing appears
broken — it just adds a permanent entry to the version vector on every start,
which every peer then carries forever. The identity is derived from storage and
written on first open, so restarts keep it.

## Encryption

Optional, per space, and invisible to the rest of the protocol: peers without
the key still merge and forward correctly, because merge never needs to
decrypt.

```dart
final cipher = await SpaceCipher.fromPassphrase('correct horse battery staple', 'kitchen-42');
final envelope = await cipher.encrypt({'note': 'private'}, opId);
```

Interoperable with the TypeScript implementation, which the tests verify by
decrypting envelopes it produced rather than by round-tripping our own.

## Storage

`MemoryAdapter` for tests and ephemeral clients. `SqliteAdapter` for anything
durable — it takes a `SqliteDriver`, so the SQL engine is your choice:
`package:sqlite3` on a server or desktop, sqflite on a phone via
`tangentfeed_flutter`.

Writing your own adapter means four capabilities, listed in section 8. The one
that matters is atomicity: a batch must land completely or not at all, or a
crash mid-write leaves a replica that disagrees with itself and converges
wrongly forever.

## What is not here yet

Compaction (section 9), a typed schema layer, and Flutter widget bindings all
exist in the TypeScript implementation and not in this one. Nothing depends on
them for interoperability — a replica that never compacts is correct, only
larger.

## Tests

```bash
dart test
```

They read `conformance/` from the repository directly rather than a copy, so
this implementation cannot drift from the contract.

## License

MIT
