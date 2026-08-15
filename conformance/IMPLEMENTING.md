# Implementing tangentfeed

Two quite different jobs share this directory. Pick the one you are doing.

- **A storage adapter** — a new backend for an existing implementation
  (React Native, Postgres, a file on disk). You are implementing an interface,
  not the protocol. Small, and the vectors already exist to prove it.
- **A new implementation** — the protocol in another language. Larger, but the
  order below keeps each step verifiable before the next one depends on it.

Throughout, `PROTOCOL.md` is normative prose and the JSON files here are the
contract. Where you think they disagree, the vectors win — please open an issue.

---

## A storage adapter

You implement one interface. The engine handles merge, clocks and replication;
you handle durability.

**Required capabilities** (§8):

1. Persist ops keyed by `id`, scannable in HLC order per device.
2. Persist materialized cells keyed by `(table, row, column)`.
3. Persist the local HLC state and per-peer frontiers.
4. Apply a batch **atomically** (§8.2) — log append, cell updates and frontier
   update succeed together or not at all.

**The one that bites:** requirement 4. A crash between writing the log and
updating materialized cells leaves a replica that disagrees with itself and
converges to the wrong state forever. If your backend has no transactions, you
need a write-ahead approach — persist the batch, then apply, then mark done,
and replay unfinished batches on open.

**How to prove it works:** run the `merge/` vectors against your adapter, not
just against memory. `packages/adapter-idb` does exactly this, and it is the
shortest worked example to copy. An adapter that passes the merge vectors and
survives a simulated crash mid-`applyBatch` is done.

**Reference adapters:** `packages/core` (memory, ~100 lines),
`packages/adapter-idb` (IndexedDB), `packages/adapter-sqlite` (SQL, with a
driver seam so it works on better-sqlite3, node:sqlite and bun:sqlite).

---

## A new implementation

Build in this order. Each milestone is verifiable on its own, which matters
because a bug in step 2 is invisible until step 5 if you build out of order.

### 1. HLC — `hlc/`

Encode, decode, compare, `send`, `receive`, drift rejection (§4).

Verify: `hlc/01-encoding.json`, `hlc/02-send-receive.json`.

Do this first. Everything downstream sorts by HLC, and an encoding bug looks
like a merge bug three milestones later.

### 2. Canonical JSON — `canonical/`

RFC 8785 (§8.1).

Verify: `canonical/01-rfc8785.json`.

Needed for encryption, but do it early — it is self-contained and the failure
mode later is "decryption mysteriously fails against other peers", which is
miserable to debug.

### 3. Merge — `merge/`

Op validation, cell-level LWW, tombstones (§3, §5).

Verify: every file in `merge/`, each through **all five orderings** in
`README.md`. Not the happy path only: the shuffled-with-duplicates ordering is
what catches non-idempotent apply.

At this point you have a working local database.

### 4. Storage

Whatever your platform offers, meeting §8. Re-run the `merge/` vectors against
it. See the adapter section above — the atomicity requirement is the same.

### 5. Sync session — `session/`

Frontier exchange and diff (§6, §6.1).

Verify: `session/01-two-party-catchup.json`.

Now sync with the reference implementation over a real transport. Passing the
vectors and failing against a real peer usually means a framing bug, and §6.1
is the table to re-read.

### 6. Encryption — optional

XChaCha20-Poly1305 with the exact parameters in §7.1.

Verify: `merge/05-encrypted-values.json` proves the part people get wrong,
that merge never requires decryption. Then round-trip against the reference
implementation, which is the only real test of your AAD and key derivation.

### 7. Compaction — optional, last

§9. No vectors yet; outcomes depend on recorded peer frontiers rather than on
ops alone. Skip it until everything else interoperates. A replica that never
compacts is correct, only larger.

---

## Traps

Collected from the places the specification is easy to read past. Each has a
vector; if you hit one and there is no vector, that is a gap worth filing.

**Object keys sort by UTF-16 code unit.** Not code point, not UTF-8 byte. They
differ once a key contains a non-BMP character: `U+1F600` sorts *before*
`U+FF00`. Most languages' default string comparison gets this wrong for JCS
purposes. See `canonical/01-rfc8785.json`.

**Numbers follow ECMAScript `Number::toString`.** `-0` serializes as `0`,
`1e21` as `1e+21`, `1e-7` as `1e-7`. If your language prints `1.0E+21` or
`-0`, you will produce ciphertext nobody else can authenticate.

**Frontiers are strictly above.** Given `{"aaaa...": "<hlc>"}` you send ops
*greater than* that HLC, not greater-or-equal. Sending the named op back is a
common off-by-one; it is harmless to correctness but doubles traffic forever.

**HLC comparison is plain bytewise string comparison** — but only because
every field is zero-padded to fixed width. If you build the string without
padding, or compare after parsing into integers inconsistently, ordering
silently diverges from every other implementation.

**`receive` must yield a clock strictly greater than both inputs.** If yours
can return a timestamp equal to the remote one, two devices can mint identical
HLCs and the deviceId tiebreak is doing work it was not meant to do.

**Tombstones do not stop later writes from being stored.** A higher-HLC cell
write after a delete is retained in the log; the row simply stays invisible.
Dropping those ops breaks un-deletion and, worse, breaks convergence with
peers that kept them.

**Unknown tables and columns must be stored and forwarded.** Unknown is not
invalid (§10). A peer that discards what it does not recognize silently
destroys data belonging to a newer version of the app.

**Duplicate ops must be ignored, not re-applied.** Ops are identified by `id`.
Reconnects replay; the vectors' duplicate ordering exists to catch this.

**Clock drift rejects the whole batch**, not the offending op (§4.5). Partial
application would leave your frontier claiming ops you dropped.

---

## When you think you are done

1. Every vector in every directory passes, merge vectors through all five
   orderings.
2. You sync bidirectionally with the reference implementation over a real
   transport, including a disconnect with writes on both sides and a
   reconnect.
3. Both replicas agree afterwards — same materialized state, same frontier.

Then please add vectors for anything you found ambiguous. A rule that was
unclear once will be unclear again, and a vector is the only durable fix.
