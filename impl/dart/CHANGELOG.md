# Changelog

## 0.1.0

First release. A second implementation of the tangentfeed protocol, validated
by the same conformance vectors as the TypeScript reference, and verified to
interoperate with it.

- Hybrid Logical Clocks with drift rejection (section 4)
- Canonical JSON per RFC 8785 (section 8.1)
- Cell-level LWW merge, tombstones, idempotent apply (sections 3, 5)
- Storage: `MemoryAdapter`, and `SqliteAdapter` over a pluggable
  `SqliteDriver` (section 8)
- Sync sessions over any transport, with `LoopbackTransport` for tests
  (section 6)
- End-to-end encryption with XChaCha20-Poly1305 (section 7), verified by
  decrypting envelopes the TypeScript implementation produced
- `openSpace` as the batteries-included entry point

Replica identity is derived from storage and persisted on first open, so a
restart keeps the same identity rather than adding an entry to the version
vector on every launch.

Not included: compaction (section 9), a typed schema layer, or Flutter widget
bindings. None affect interoperability.
