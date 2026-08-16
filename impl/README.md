# Implementations

`packages/` holds the TypeScript reference implementation. This directory holds
others, validated by the same `conformance/` vectors.

| Directory | What it is | Verification |
|---|---|---|
| `dart/` | The protocol in Dart. Pure, no Flutter dependency | 118 tests against the shared vectors |
| `flutter/` | Platform seams: sqflite storage, WebRTC transport | Static analysis only — see below |

## dart/

Follows the build order in `conformance/IMPLEMENTING.md`.

```bash
cd impl/dart
dart pub get
dart test
```

| Milestone | Verified by |
|---|---|
| 1. HLC | `hlc/` vectors: encoding, ordering, send, receive, overflow, drift |
| 2. Canonical JSON | `canonical/` vectors, including RFC 8785's own |
| 3. Merge | `merge/` vectors, all five orderings including duplicates |
| 4. Storage | `merge/` vectors again on real SQLite, plus a rollback test for section 8.2 |
| 5. Sync session | `session/` vectors, plus offline-then-reconnect over a loopback |
| 6. Encryption | Envelopes produced by the TypeScript implementation |

Two things are worth knowing if you read the source.

**Canonical JSON is not `jsonEncode`.** Dart gets UTF-16 key ordering right for
free, and `double.toString()` already matches ECMAScript for non-whole values.
But Dart separates `int` from `double` where JSON has one number type, so
`jsonEncode` emits `100.0` and `-0.0`. Since the plaintext under encryption is
canonical JSON, that single character would produce ciphertext no other
implementation can authenticate. `canonicalNumber` handles it and the RFC 8785
vector is what proves it.

**Encryption is validated against the other implementation, not itself.** A
self-round-trip passes even with the wrong HKDF info string or the wrong AAD,
so long as it is wrong consistently. `test/interop_fixture.json` holds
envelopes the TypeScript implementation produced; regenerate them with
`node test/interop_fixture.mjs > test/interop_fixture.json`.

## flutter/

Two platform seams over the pure Dart package. Neither contains protocol logic:
`SqliteAdapter` and `Replicator` are already tested in `dart/`, and these only
teach them to speak sqflite and WebRTC.

**Status: builds for web and iOS, not yet run on a device.** `flutter analyze`
is clean, `flutter build web` and `flutter build ios` both succeed, so the
APIs are used correctly and CocoaPods resolves the WebRTC framework. Neither
seam has been exercised at runtime. Treat them as unproven until they have.

`example/` is a runnable two-peer app, and `TESTING.md` walks through proving
them — including the iPhone run, which is the only path that exercises
sqflite.

What to check first when you do run them:

- **Storage** — that a batch interrupted partway leaves the log and the
  materialized cells agreeing. `dart/test/sqlite_test.dart` has that test
  against package:sqlite3; the sqflite path deserves the same.
- **Transport** — that a Dart peer and a browser peer actually converge. The
  transport is wire-compatible by construction: same signaling messages, same
  `tangentfeed` DataChannel label, same rule that the lower deviceId initiates.
  Construction is not evidence.
