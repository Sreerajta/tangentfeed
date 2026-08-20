# @tangentfeed/core

Protocol engine for tangentfeed: Hybrid Logical Clocks, the cell-level LWW operation log, replication, compaction, and operation signatures.

Two dependencies, both audited and both from the same family: `@noble/curves` for Ed25519 and `@noble/hashes` for SHA-256. It was dependency-free until signing landed in v0.2; rolling our own curve arithmetic to keep that claim would have been a bad trade.

Use this directly if you are supplying your own storage adapter or transport, or implementing against [PROTOCOL.md](https://github.com/sreerajta/tangentfeed/blob/main/PROTOCOL.md).

Part of [tangentfeed](https://github.com/sreerajta/tangentfeed). MIT licensed.
