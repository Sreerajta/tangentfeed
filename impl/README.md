# Implementations

`packages/` holds the TypeScript reference implementation. This directory holds
others, validated by the same `conformance/` vectors.

| Directory | What it is | Verification |
|---|---|---|
| `dart/` | The protocol in Dart. Pure, no Flutter dependency | 118 tests against the shared vectors |
| `flutter/` | Platform seams: sqflite storage, WebRTC transport | Transport verified iPhone ↔ browser; storage partly — see below |

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

`example/` is a runnable two-peer app; `TESTING.md` walks through proving both
seams, including the iPhone run.

### Transport — verified on hardware

An iPhone and a desktop browser, both running this code, synced over real
WebRTC DataChannels through the signaling relay:

- writes propagated in both directions
- updates to an existing row propagated in both directions
- the phone went offline, both sides wrote, and they converged on reconnect

That last one is the claim the whole design rests on, and it is no longer
theoretical.

Untested: peers on *different* networks. Both were on one hotspot, so ICE
found a direct path and never had to traverse a NAT, which is where WebRTC
actually gets hard and where a TURN server becomes necessary.

### Storage — partly verified

The iPhone run used `SqfliteDriver` throughout, so every read, write and merge
in that session went through sqflite, including the operations queued while
offline.

Not yet confirmed: **durability across a process restart.** Nothing has proven
the data is on disk rather than merely in a page cache that happened to
outlive nothing. Force-quitting the app and finding the tasks still there is
the test, and it takes twenty seconds.

Also still open: that a batch interrupted partway leaves the log and the
materialized cells agreeing. `dart/test/sqlite_test.dart` proves it against
package:sqlite3 with an injected failure; the sqflite path has no equivalent.
