# Changelog

All packages in this repository share a version. The protocol version they
implement is stated for each release, because that is what determines whether
two peers can talk.

## 0.2.0 — protocol v0.2

**Not wire-compatible with 0.1.0.** A 0.1 peer and a 0.2 peer abort at `hello`,
and existing local data is unreadable. Nothing was published at 0.1.0, so no
migration path is provided.

### Signed operations

Every operation now carries an Ed25519 signature, and `deviceId` is derived
from the public key rather than chosen, so an op cannot be forged and an
identity cannot be claimed without the key that proves it.

- `op.sig` is a required field. Unsigned ops are invalid in every space; there
  is no per-space policy and no tolerance mode, because a mode that accepts
  unsigned ops offers no protection.
- `deviceId` is the first 16 bytes of `SHA-256(publicKey)`, widened from 64 to
  128 bits. HLC strings therefore grow from 34 to 50 characters.
- Signing is **encrypt-then-sign**. This is forced rather than preferred:
  §7 requires keyless peers to merge and forward, and signing plaintext would
  make signatures unverifiable by exactly those peers.
- Keys travel in the sync session — `hello` carries the sender's, and a new
  `keys` message carries every key it holds. The directory is self-validating,
  since a key that does not hash to its claimed id is discarded.
- Verification runs before the drift check and before any write, so a forged
  op never reaches storage and a batch containing one leaves nothing behind.

**What this does not do:** it proves *who* wrote an op, not that they were
*allowed* to. Any peer can generate a keypair and participate. Membership,
roles and revocation are later phases; until then a space name remains a bearer
credential and the signaling relay should be treated as private.

### Typed schemas

New `@tangentfeed/schema`: a field DSL that infers TypeScript types and
validates local writes. Validation is a local precondition — rejected data
never becomes an op — so it cannot affect convergence, and a peer on a
different schema still syncs completely. Read types are an assertion about the
schema you write through, not a guarantee about the op log; `parseRow` is the
opt-in check.

### Protocol and conformance

- Canonical JSON (§8.1) pinned to RFC 8785. Verified descriptive rather than
  normative: the existing implementation already matched it exactly, including
  the RFC's own test vector.
- §6.1 gains a message schema table.
- New vector suites: `hlc/`, `canonical/`, `session/`, `signatures/`, plus
  `test-keys.json`. All existing vectors regenerated for the wider `deviceId`
  and signatures.
- `conformance/IMPLEMENTING.md` sequences a new implementation and lists the
  traps.
- Appendix B previously advertised vectors that did not exist; it now matches
  reality.

### Breaking changes beyond the wire format

- `SyncEngine.open` no longer takes `deviceId`, and `generateDeviceId` is
  removed. Identity comes from the stored keypair.
- `openSpace` loses its `deviceId` option and gains `replica`, which names the
  local database when several replicas share one origin. It is not an identity.
- `StorageAdapter` gains `getDeviceKey` / `setDeviceKey`.
- The SQLite adapter's `ops` table gains a `sig` column.
- `@tangentfeed/core` is no longer dependency-free: it carries `@noble/curves`
  and `@noble/hashes`.

### Other

- Every package now ships a `LICENSE` and declares `engines.node >= 20`.

## 0.1.0 — protocol v0.1

Initial implementation: HLC with drift protection, cell-level LWW over an
operation log, tombstones, frontier-based sync, IndexedDB and SQLite adapters,
BroadcastChannel and WebRTC transports, a blind signaling relay, end-to-end
encryption, compaction, and React bindings. Never published.
