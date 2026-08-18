# Signed operations — protocol v0.2, phase 1

**Status:** approved design, not yet implemented
**Date:** 2026-08-18
**Scope:** phase 1 of four. See "Where this sits" below.

## Problem

There is no write authorization. The signaling server authenticates nobody, and
`PROTOCOL.md` never says who may write to a space, so a space name is a bearer
credential with no revocation.

Encryption does not help. §7.2 keeps row tombstones plaintext on purpose, so
that keyless relays can order deletes. A peer with no key therefore cannot read
the data but **can tombstone every row it observes**. The worst case is silent,
replicated, permanent data loss.

## Where this sits

Full per-identity permissions decompose into four phases. This spec covers only
the first.

| Phase | Delivers | Closes |
|---|---|---|
| **1. Authenticated writes** | Ed25519 signatures; `deviceId` derived from the public key | Forging ops, impersonating a device |
| 2. Membership | A roster of member keys rooted in the space creator | A stranger joining and tombstoning |
| 3. Roles | owner / writer / reader | Insider over-reach |
| 4. Revocation | Removing a member, re-keying | A departed member |

**Phase 1 does not close the original attack.** It makes ops unforgeable and
identities unspoofable, which every later phase depends on. A stranger with
their own keypair can still participate until phase 2 exists. This is stated
here so nobody mistakes phase 1 for the fix.

## Identity

`deviceId` becomes derived rather than random:

```
deviceId = lowercase hex of the FIRST 16 BYTES of SHA-256(publicKey)
         → 32 characters, 128 bits
```

A device cannot claim an identity it holds no key for.

**Width is 128 bits, not the current 64.** At 64 bits a targeted impersonation
costs about 2^64 keypair generations — expensive but reachable, and this
identifier is becoming a security boundary. HLC strings therefore grow from 34
to 50 characters:

```
{millis:12}-{counter:4}-{deviceId:32}
```

Lexicographic ordering still equals logical ordering: every field remains
fixed-width, zero-padded, lowercase hex.

## Key distribution

A hash is one-way, so a verifier needs the public key from somewhere, and ops
travel transitively — Alice's op reaches Carol via Bob, and Carol never had a
session with Alice.

Keys travel in the sync session:

- `hello` carries the sender's own public key.
- A new `keys` message carries every device key the sender holds. It is sent
  before any `ops` message in a session.
- Received keys are persisted.

Rejected alternatives: embedding the key in every op costs 44 characters on top
of the signature's 88, on a format where one row edit is several ops; making
`deviceId` *be* the key pushes HLC strings to 82 characters, duplicated across
`id` and `hlc`.

**The `keys` message needs no authentication.** Because `deviceId` is the hash
of the key, an entry whose key does not hash to its claimed id is discarded.
The directory is self-validating.

An op from a device whose key is unknown is **rejected, not queued**. In a
well-formed session `keys` precedes `ops`, so this should not arise; treating
it as an error keeps the state machine small, and the sender resends after the
next exchange.

## What is signed

```
message = "tangentfeed/v2/op" || canonicalJson({id, table, row, column, value, hlc, device})
sig     = Ed25519(privateKey, message)
op.sig  = base64(sig)                          // 64 bytes → 88 characters
```

Canonical JSON (§8.1) is reused rather than inventing a serialization: it is
RFC 8785, already cross-implementation verified, and already load-bearing for
encryption. The domain prefix prevents a signature being valid in any other
context.

The signature covers `id`, `hlc` and `device`, so a valid op cannot be lifted
and repointed at another row, table or timestamp.

### Encrypt-then-sign

Forced, not preferred. §7 requires keyless peers to merge and forward, so the
`value` they see is the `e1:` envelope. Signing plaintext would make signatures
unverifiable by exactly the peers §7 exists to support. Signing the ciphertext
keeps a keyless relay able to verify everything it forwards.

## Wire format

| Change | Detail |
|---|---|
| `op.sig` | New required field. Base64. Always present |
| Wire version | `1` → `2`. A v1 and a v2 peer abort at `hello` |
| §3 field table | Gains `sig`; "exactly these fields" now means eight |
| §6.1 | `hello` gains `key`; new `keys` message |

Unsigned ops are invalid in every space. There is no per-space policy and no
tolerance mode: a mode that accepts unsigned ops provides no protection, since
an attacker simply omits the field.

`MAX_OP_BYTES` stays 64 KiB.

### Validation order

1. Shape (§3)
2. **Signature**
3. Clock drift (§4.5)
4. Merge (§5)

Signature verification precedes the drift check so an unauthenticated peer
cannot provoke clock errors, and precedes merge so a forged op never reaches
storage.

## Storage

`StorageAdapter` gains two methods:

```
getDeviceKey(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array } | undefined>
setDeviceKey(key: { publicKey: Uint8Array; privateKey: Uint8Array }): Promise<void>
```

A keypair is generated and stored on first open, before any data op, mirroring
how the identity is already claimed today.

Breaking for the five existing adapters: memory, IndexedDB and SQLite in
TypeScript; memory and SQLite in Dart.

**Known limitation, deliberately out of scope.** The private key is stored in
the clear, alongside the data it protects. On a device it belongs in Keychain
or Keystore. The space secret already has this exposure, so this spec does not
widen it; it is recorded as follow-up work rather than solved here.

## Blast radius

All nine conformance vector files are invalidated — not only the merge ones,
because the wider `deviceId` changes every HLC string in `merge/`, `session/`
and `hlc/`. A test keypair is committed so both implementations regenerate
identically.

Existing local data becomes unreadable. Accepted: nothing is published, and the
only real data is test data on one phone.

Touched: `PROTOCOL.md`, `@tangentfeed/core`, `@tangentfeed/crypto`, the
facade, three TypeScript adapters, and the mirror of all of it in Dart.

## Testing

1. **`conformance/signatures/`** — fixed keypair, fixed op, expected signature.
   This is what makes the scheme cross-implementation rather than merely
   self-consistent, as `interop_fixture.json` did for encryption.
2. **Negative vectors** — tampered value, tampered table, a signature lifted
   from a different op, wrong device, absent `sig`. These matter more than the
   positive case: a verifier that accepts everything passes every positive test.
3. **Cross-implementation** — Dart verifies signatures TypeScript produced and
   the reverse.
4. **Regenerated existing suites**, which must pass with unchanged behaviour.
   Signing must not alter merge outcomes.
5. **Unknown-key rejection** — an op from a device whose key is not held is
   refused.

## Non-goals

Membership, roles, revocation and key rotation, all of which are phases 2 to 4.
Encrypting the stored private key. Metadata privacy, which §7.2 already
declares a v1 non-goal. Any change to merge semantics: signing is a gate in
front of merge and must leave §5 untouched.
