# Changelog

## 0.1.0

First release. Two platform seams over `package:tangentfeed`; no protocol logic
lives here.

- `SqfliteDriver` — sqflite behind the `SqliteDriver` seam (section 8)
- `WebRTCTransport` — sync over DataChannels, wire-compatible with the
  TypeScript transport: same signaling messages, same `tangentfeed` channel
  label, same rule that the lower deviceId initiates (section 6)

Both have been run on an iPhone against a browser peer: writes and updates in
both directions, convergence after the phone went offline with writes on both
sides, and data surviving an app restart.

Untested: peers on different networks, so NAT traversal and TURN are unproven;
and crash-atomicity on the sqflite path specifically.
