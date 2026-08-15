# TangentFeed Protocol — v0.1 (draft)

Status: v0.1 — implemented and covered by the conformance suite. Refinements are
expected before v1.0 freezes the wire format.

Naming: this protocol was developed under the working name "syncdb" and renamed
to TangentFeed before first release. Three identifiers carry the name and are
therefore normative:

| Identifier | Value | Where |
|---|---|---|
| HKDF info string | `tangentfeed/v1/cells` | §7.1 key derivation |
| WebRTC data channel label | `tangentfeed` | transport layer |
| Local database / channel prefix | `tangentfeed:{space}` | storage and BroadcastChannel naming |

An implementation using the former values derives different keys and opens
different channels, so it will not interoperate. Since nothing was published
under the old name, no migration path is defined.

This document specifies a protocol for peer-to-peer synchronization of
schema-shaped, row/column structured data between devices, over any message
transport, on top of any storage engine. An implementation in any language that
follows this spec and passes the conformance suite will converge with any other
implementation.

The protocol is the product. Code is commentary.

---

## 1. Design goals and non-goals

### Goals

- **Offline-first.** Every peer holds a full copy of a space and can read/write
  with zero latency, forever, without connectivity.
- **Convergence.** Any set of peers that exchange all operations reach
  byte-identical state, regardless of delivery order, duplication, or delay.
- **Transport-agnostic.** Works over WebRTC, WebSocket, HTTP polling, Unix
  pipes, or files on a USB stick. The transport only needs to move opaque
  byte blobs; ordering and reliability are NOT required.
- **Storage-agnostic.** IndexedDB, SQLite, LMDB, Postgres, MMKV, flat files.
- **Implementable in an afternoon.** A minimal conforming client should be
  a few hundred lines in any mainstream language.
- **Zero-knowledge-capable.** Cell values may be end-to-end encrypted; relays
  and mailboxes never need plaintext.

### Non-goals (v1)

These are explicitly out of scope for v1. The op model is designed so they can
be added later without breaking the protocol:

- Partial replication / per-row sync filters
- Multi-user permissions or per-row ACLs (v1 syncs a whole space between
  trusted devices of one owner)
- Rich CRDT value types (collaborative text, ordered lists, counters)
- Query language of any kind
- Server-authoritative validation

---

## 2. Core concepts

- **Space** — the unit of replication. A space is a set of tables. Peers sync
  whole spaces. Identified by a `spaceId` (opaque string, recommended: ULID).
- **Peer / Device** — a participant holding a replica. Identified by a
  `deviceId` (see §4.3).
- **Table / Row / Column** — data is shaped like relational tables. A row is
  identified by a client-generated `rowId` (ULID, §4.4). Rows have no
  server-assigned identity, ever.
- **Cell** — the atomic unit of synchronization: `(table, rowId, column)`.
  Concurrent edits to *different* columns of the same row never conflict.
- **Operation (op)** — an immutable record of one cell write (or row
  tombstone). The op log is the source of truth; materialized tables are a
  cache derived from it.
- **HLC** — Hybrid Logical Clock timestamp, the total order over all ops in a
  space (§4).

## 3. Operation format

An op is a map with exactly these fields:

| field    | type            | description                                        |
|----------|-----------------|----------------------------------------------------|
| `id`     | string          | globally unique op id: `"{hlc}"` (§4.2). The HLC string IS the op id. |
| `table`  | string          | table name, `[a-zA-Z_][a-zA-Z0-9_]{0,63}`          |
| `row`    | string          | rowId, a ULID (§4.4)                               |
| `column` | string          | column name, same charset as table; OR the reserved value `"-"` for row tombstones |
| `value`  | any JSON value or `null` | the new cell value. For tombstones (`column: "-"`): `true` = row deleted. `null` = cell cleared. |
| `hlc`    | string          | HLC timestamp string (§4.2), equal to `id` in v0.1 |
| `device` | string          | deviceId of the writer (redundant with hlc suffix; kept for readability, MUST match) |

Because one device can never issue two ops with the same HLC (§4.1), the HLC
string is globally unique and doubles as the op id. Implementations MUST treat
ops with an already-seen `id` as duplicates and ignore them (idempotency).

### 3.1 Encoding

v0.1 wire encoding is JSON (UTF-8). Ops travel in batches:

```json
{ "v": 1, "space": "<spaceId>", "ops": [ { ...op }, ... ] }
```

A future protocol version may add CBOR; the version field exists so peers can
negotiate. Implementations MUST ignore unknown top-level fields (forward
compatibility).

### 3.2 Value encoding

`value` is any JSON value. Implementations MUST preserve values byte-exactly
as JSON (after canonical re-serialization, §8.1) even for columns they do not
understand. When end-to-end encryption is enabled (§7), `value` is instead a
string of the form `"e1:<base64 ciphertext>"` and the plaintext JSON is only
visible after decryption.

## 4. Hybrid Logical Clock

### 4.1 State and algorithms

Each device maintains one HLC per space: `(millis, counter, deviceId)`.

- `millis` — unsigned integer, milliseconds since Unix epoch, ≤ 2^48 − 1.
  (The drift rule in §4.5 means values near this ceiling can never be
  accepted from a peer; the 48-bit width is pure encoding headroom.)
- `counter` — unsigned integer, 0 ≤ counter ≤ 0xFFFF (65535).
- `deviceId` — see §4.3.

**send/local event** (issuing a new op), given physical wall clock `pt`:

```
if pt > millis:        millis = pt; counter = 0
else:                  counter = counter + 1
if counter > 0xFFFF:   millis = millis + 1; counter = 0   // overflow rollover
return (millis, counter, deviceId)
```

**receive** (observing a remote op's HLC `r`), given physical clock `pt`:

```
if r.millis > pt + MAX_DRIFT: reject op batch with error CLOCK_DRIFT (§4.5)
m = max(millis, r.millis, pt)
if m == millis and m == r.millis:  counter = max(counter, r.counter) + 1
elif m == millis:                  counter = counter + 1
elif m == r.millis:                counter = r.counter + 1
else:                              counter = 0
millis = m
```

These are the standard Kulkarni et al. HLC rules with a 16-bit counter and
explicit overflow rollover. After `receive`, the local clock is strictly
greater than both the previous local clock and the received timestamp, which
preserves causality: any op written after seeing remote data sorts after it.

### 4.2 String encoding (canonical, sortable)

```
{millis as 12 lowercase hex chars}-{counter as 4 lowercase hex chars}-{deviceId}
```

Example: `018f6e2a9c40-0003-a1b2c3d4e5f60718`

Properties: fixed width (12 + 1 + 4 + 1 + 16 = 34 chars), and **plain
bytewise/lexicographic string comparison equals logical HLC comparison**.
Implementations MAY compare HLCs as strings; the conformance suite verifies
both paths agree.

### 4.3 deviceId

16 lowercase hex characters (64 random bits), generated once per device per
space and persisted. Collision probability is negligible at "devices of one
user" scale. deviceId is the final tiebreaker in HLC ordering; two ops can
only be fully equal if they are the same op.

### 4.4 rowId

A ULID (26-char Crockford base32, lowercase not required but canonical form is
uppercase per ULID spec). Client-generated at insert time. Never reused after
tombstoning.

### 4.5 Clock drift protection

`MAX_DRIFT` = 300 000 ms (5 minutes). An op whose HLC `millis` exceeds the
receiver's physical clock by more than MAX_DRIFT MUST be rejected (the whole
batch fails with `CLOCK_DRIFT`), because accepting it would let one broken
clock poison LWW for the entire space far into the future. The rejected peer
should surface an error telling the user to fix their clock.

## 5. Merge rules (LWW per cell)

For each cell `(table, row, column)`, the winning op is the one with the
greatest HLC (string comparison, §4.2). Materialized state is:

- For every cell: the `value` of its winning op, unless the row is tombstoned.
- A row is **tombstoned** iff the winning op for `(table, row, "-")` has
  `value: true`. Tombstoned rows are absent from materialized state, but their
  ops (including the tombstone) are retained until compaction (§9).
- A tombstone does NOT block later cell writes with higher HLCs from being
  stored in the log, but the row stays invisible unless a higher-HLC op on
  `(table, row, "-")` sets `value` to something other than `true`
  (un-deletion is representable but implementations SHOULD NOT expose it in v1
  APIs).

Merge is commutative, associative, and idempotent. Delivery order, duplicates,
and interleaving cannot affect the final state. This is the property the
conformance suite hammers hardest.

## 6. Sync session

A sync session between two peers, over any bidirectional message channel:

1. **Hello** — each peer sends `{ "t": "hello", "v": 1, "space": spaceId,
   "schemaVersion": n, "clock": <its current HLC string> }`. On receipt, each
   peer runs the HLC `receive` rule on the other's clock (drift check
   included). Space mismatch aborts.
2. **Cursor exchange** — each peer sends `{ "t": "since", "have": frontier }`
   where `frontier` is a map `deviceId → highest HLC string seen from that
   device` (a version vector in HLC form).
3. **Diff & transfer** — each peer sends every op it holds whose
   `(device, hlc)` is above the other's frontier, in batches
   `{ "t": "ops", "ops": [...] }`. Batch size is implementation-defined
   (recommended ≤ 500 ops or 256 KiB).
4. **Ack** — receiver applies batches atomically (§8.2), updates its frontier,
   replies `{ "t": "ack", "frontier": updated }`.
5. **Live tail** — after catch-up, peers forward new local ops as they happen
   with the same `ops` message. Steps 2–4 rerun on every reconnect.

Because ops are idempotent and merge is order-independent, a peer may run
sessions with many peers concurrently (gossip); no coordination is needed.

### 6.1 Message schema

Every message is a JSON object with a `t` discriminator. Implementations MUST
ignore unknown fields and unknown `t` values (forward compatibility) rather
than aborting the session.

| `t` | Field | Type | Required | Meaning |
|---|---|---|---|---|
| `hello` | `v` | integer | yes | Wire version. `1` in v0.1 |
| | `space` | string | yes | Space id. A mismatch aborts (§11 `SPACE_MISMATCH`) |
| | `clock` | string | yes | Sender's current HLC string (§4.2) |
| | `schemaVersion` | integer | no | Advisory only (§10). Absent means "unknown"; never a reason to refuse |
| `since` | `have` | object | yes | Frontier: `deviceId` → highest HLC string seen from that device. `{}` means "I have nothing" |
| `ops` | `ops` | array | yes | Zero or more ops (§3). An empty array is legal and means "nothing above your frontier" |
| `ack` | `frontier` | object | yes | Sender's frontier after applying. Same shape as `since.have` |

Notes that a second implementation needs:

- **`hello` is not a handshake gate.** Both sides send it unprompted on
  channel open; neither waits for the other's before sending `since`.
- **The session is symmetric.** There is no client and no server. Both peers
  run all five steps simultaneously, and a peer with nothing to send still
  sends `since` and still replies `ack`.
- **Catch-up completion is not signalled.** A peer knows it is caught up when
  it has applied every op above the frontier it advertised; there is no "done"
  message. Live tail is simply the same `ops` message continuing to arrive.
- **`ack` is informational**, not flow control. A sender MUST NOT wait for an
  `ack` before sending the next batch. Its purpose is to let each side learn
  the other's frontier without a second `since` round.
- **Batch size** is implementation-defined (recommended ≤ 500 ops or 256 KiB).
  A receiver MUST NOT assume any particular batching, including that one
  logical batch arrives as one message.
- **Reconnect** re-runs steps 2–4. Because ops are idempotent, replaying
  everything is always safe, and a peer that has lost its frontier MAY send
  `{"t":"since","have":{}}` to request the full log.
- **Ordering within a session** is not required. Ops may arrive in any order
  relative to each other and merge still converges (§5).

Transcript vector: `/conformance/session`.

## 7. End-to-end encryption

Encryption is optional per space and invisible to the rest of the protocol:
an encrypting peer and a non-encrypting peer run identical merge, sync, and
compaction logic, because only the `value` field changes shape.

### 7.1 Scheme

```
key        = HKDF-SHA256(ikm = space secret, salt = "",
                         info = "tangentfeed/v1/cells", len = 32)
nonce      = 24 random bytes, fresh for every encryption
plaintext  = canonical JSON of the cell value (§8.1)
AAD        = op id, UTF-8
ciphertext = XChaCha20-Poly1305(key, nonce, AAD, plaintext)
value      = "e1:" || base64(nonce || ciphertext)
```

- **Random nonces, not counters.** 192-bit nonces make collision probability
  negligible without any persistent counter state — important for a system
  where devices write while offline and may be restored from backups, both of
  which can rewind a counter.
- **AAD binds ciphertext to op identity.** A ciphertext lifted from one op and
  pasted into another fails authentication instead of silently relocating a
  value into a different cell. Since op ids are unique (§3), this also means a
  given ciphertext is only ever valid in exactly one place in the log.
- **Key derivation.** The space secret is 32 random bytes shared out of band
  (QR code, password manager). Implementations MAY derive it from a human
  passphrase; the reference implementation uses scrypt (N=2^15, r=8, p=1) with
  the space id as salt.

### 7.2 What is NOT encrypted, and why

`table`, `row`, `column`, `hlc`, and `device` remain plaintext. Consequences:
a relay or mailbox learns the shape and timing of activity (which tables
exist, how many rows, when a device wrote) but never any cell content.

Row tombstones (`column: "-"`) also remain plaintext. This is deliberate:
§5 merge rules must be evaluable by a peer that cannot decrypt, so that
keyless relays and future partial-sync peers can still order and apply
deletes correctly. A relay therefore learns that a row was deleted, never
what it held.

Metadata privacy is an explicit v1 non-goal. A future version may add
encrypted table/column names via a deterministic keyed mapping; the op format
does not need to change for that.

### 7.3 Mixed and rotated keys

- Values not carrying the `e1:` prefix MUST be returned as-is. A space may
  contain plaintext ops written before encryption was enabled.
- Decryption failure MUST surface as `DECRYPT_FAIL` (§11) and MUST NOT be
  silently swallowed or treated as a merge conflict. An op that cannot be
  decrypted is still stored, still replicated, and still participates in LWW;
  only its plaintext is unavailable to that peer.
- Key rotation is out of scope for v1. Because AAD binds ciphertext to op id,
  re-encrypting under a new key requires writing new ops (new ids), which is
  a data migration rather than a protocol operation.

## 8. Storage requirements

The protocol does not mandate a storage engine; it mandates capabilities:

- Persist ops keyed by `id`, scannable in HLC order per device.
- Persist materialized cells keyed by `(table, row, column)`.
- Persist the local HLC state and per-peer frontiers.
- Applying an op batch MUST be atomic (§8.2).

### 8.1 Canonical JSON

Canonical JSON is **RFC 8785 (JSON Canonicalization Scheme, JCS)**. That
specification is normative here; this section only highlights the parts
implementations get wrong.

- **Object keys** are sorted by **UTF-16 code unit**, not by Unicode code
  point and not by UTF-8 byte. The two orders differ once non-BMP characters
  are involved: `U+1F600` (a surrogate pair, first unit `0xD83D`) sorts
  *before* `U+FF00`, though its code point is higher.
- **Numbers** serialize per ECMAScript `Number::toString`: `-0` becomes `0`,
  `1e21` becomes `1e+21`, `1e-7` becomes `1e-7`, and trailing zeros are
  dropped. Non-finite numbers are not valid JSON and MUST be rejected.
- **Strings** use the shortest JSON escape: `\b \t \n \f \r \" \\` where
  available, `\u00XX` lowercase hex for other control characters, and raw
  UTF-8 for everything else. Non-ASCII characters are NOT escaped. Lone
  surrogates are escaped as lowercase `\udXXX`.
- No whitespace anywhere.

> In JavaScript, `JSON.stringify` combined with `Object.keys(o).sort()` already
> produces exactly this, because JCS was written to match ECMAScript. In most
> other languages it does not come free — in particular, sorting keys with the
> platform's default string comparison is usually code-point or byte order and
> will silently disagree on non-BMP keys.

This matters beyond hashing: under end-to-end encryption (§7) the plaintext is
canonical JSON, so two implementations that disagree by a single byte produce
ciphertext the other cannot authenticate. Vectors: `/conformance/canonical`.

### 8.2 Atomic batches

Applying an op batch (log append + cell updates + frontier update) MUST be
all-or-nothing. A crash mid-apply must never leave the log and materialized
state disagreeing.

## 9. Compaction

Implementations MUST NOT let the op log grow without bound. Reclamation is
governed by the **compaction horizon**: for each writer device `d`,

```
horizon[d] = min( own_frontier[d],
                  peer_frontier[p][d] for every known peer p )
```

where an absent entry counts as zero. An op at or below `horizon[op.device]`
has demonstrably reached every peer this replica knows about.

### 9.1 Ordinary ops

An op MAY be discarded when BOTH hold:

  (a) it is not the winning op for its cell (§5), and
  (b) `op.hlc <= horizon[op.device]`.

Condition (a) alone would preserve cell convergence — a peer that never
receives a superseded value still receives the winner — but (b) is required so
that a peer which has not yet seen an op can still be sent it.

### 9.2 Tombstoned rows

Row tombstones are the dangerous case. Per §5 a deleted row stays invisible
because the tombstone is the winning op on the `"-"` cell, even when later
cell writes carry higher HLCs. Discarding a tombstone while any peer still
holds unsynced writes for that row would let those writes arrive, find no
tombstone, and **resurrect deleted data**.

Therefore a tombstoned row MAY be reclaimed only when ALL of the following
hold, and MUST be reclaimed whole:

  1. the winning op on `(table, row, "-")` is a tombstone (`value: true`),
  2. `horizon` has passed that tombstone, and
  3. `horizon` has passed EVERY op belonging to that row.

Reclaiming "whole" means removing all of the row's ops AND all of its
materialized cells together. Removing the tombstone while leaving the row's
other cells behind resurrects the row locally on the next read, and is a
conformance failure.

Implementations SHOULD NOT perform tombstone reclamation by default: a peer
that has been offline beyond the horizon can no longer learn that the row was
deleted. Expose it as an explicit option.

### 9.3 Reporting

Because a single long-absent peer pins the horizon and blocks all reclamation,
implementations SHOULD report which peers are holding it back rather than
silently doing nothing.

A peer that has been offline past the compaction horizon re-syncs by full
state transfer (v2 topic).

## 10. Schemas and migrations

Schemas live ABOVE the sync layer. The engine syncs opaque cells; a schema
layer provides typed access. Protocol-level rules exist only to keep mixed
versions safe:

- **Additive-only.** New tables and new columns may be added at any time.
  Renaming or retyping columns is forbidden; add a new column and backfill.
- **Preserve unknown data.** A peer MUST store and forward ops for tables and
  columns it does not recognize. Unknown ≠ invalid.
- **schemaVersion** is an integer exchanged in `hello`. It is advisory: peers
  MUST interoperate across versions. It exists so apps can prompt "update your
  other device" and so future tooling can translate.

## 11. Errors

| code          | meaning                                    |
|---------------|--------------------------------------------|
| `CLOCK_DRIFT` | remote HLC too far in the future (§4.5)    |
| `BAD_OP`      | op fails validation (shape, charset, size) |
| `SPACE_MISMATCH` | hello for a different space             |
| `DECRYPT_FAIL`| E2E ciphertext rejected                    |

Limits (v0.1): op JSON ≤ 64 KiB; table/column names ≤ 64 chars; a batch ≤ 1000
ops. Oversized inputs are `BAD_OP`.

---

## Appendix A: Worked example

Device `aaaaaaaaaaaaaaaa` inserts a task, device `bbbbbbbbbbbbbbbb`
concurrently marks it done while `a` retitles it:

```json
{"id":"018f6e2a9c40-0000-aaaaaaaaaaaaaaaa","table":"tasks","row":"01HZX3NDEKTSV4RRFFQ69G5FAV","column":"title","value":"Buy milk","hlc":"018f6e2a9c40-0000-aaaaaaaaaaaaaaaa","device":"aaaaaaaaaaaaaaaa"}
{"id":"018f6e2a9c41-0000-aaaaaaaaaaaaaaaa","table":"tasks","row":"01HZX3NDEKTSV4RRFFQ69G5FAV","column":"done","value":false,"hlc":"018f6e2a9c41-0000-aaaaaaaaaaaaaaaa","device":"aaaaaaaaaaaaaaaa"}
{"id":"018f6e2b1000-0000-bbbbbbbbbbbbbbbb","table":"tasks","row":"01HZX3NDEKTSV4RRFFQ69G5FAV","column":"done","value":true,"hlc":"018f6e2b1000-0000-bbbbbbbbbbbbbbbb","device":"bbbbbbbbbbbbbbbb"}
{"id":"018f6e2b2222-0000-aaaaaaaaaaaaaaaa","table":"tasks","row":"01HZX3NDEKTSV4RRFFQ69G5FAV","column":"title","value":"Buy oat milk","hlc":"018f6e2b2222-0000-aaaaaaaaaaaaaaaa","device":"aaaaaaaaaaaaaaaa"}
```

Delivered in ANY order to ANY peer, the row converges to
`{ title: "Buy oat milk", done: true }`. Neither edit is lost, because the
cell — not the row — is the unit of conflict.

## Appendix B: Conformance

A conforming implementation passes the language-neutral test vectors in
`/conformance`. `/conformance/README.md` is the authority on what exists, what
each vector pins down, and the ordering matrix every merge vector must be run
through. As of v0.1 the suite covers:

| Directory | Covers | Spec |
|---|---|---|
| `merge/` | Cell-level LWW, tiebreaks, tombstones, null and unknown columns, encrypted values | §3, §5, §10 |
| `hlc/` | String encoding, ordering, send and receive rules, counter overflow, drift rejection | §4 |
| `canonical/` | RFC 8785 canonicalization, including the cases that differ across languages | §8.1 |
| `session/` | A recorded two-party session transcript | §6 |

Not yet covered, and stated plainly so nobody goes looking: compaction
outcomes (§9), which depend on peer frontiers rather than on ops alone.

New implementations should start with `/conformance/IMPLEMENTING.md`, which
sequences the work and lists the traps.
