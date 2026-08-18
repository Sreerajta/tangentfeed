# Conformance suite

Language-neutral test vectors for the tangentfeed protocol. An implementation in any
language that passes these is interoperable with any other that does.

This directory is the contract. `PROTOCOL.md` explains the rules in prose;
these files pin them down as data.

**Writing an implementation or an adapter? Start with
[IMPLEMENTING.md](./IMPLEMENTING.md)**, which sequences the work, says what to
verify at each step, and lists the traps.

## Layout

| Directory | Pins down | Spec |
|---|---|---|
| `hlc/` | Encoding, ordering, send and receive, counter overflow, drift rejection | §4 |
| `canonical/` | RFC 8785 canonicalization, including cases that differ across languages | §8.1 |
| `merge/` | Cell-level LWW, tiebreaks, tombstones, null and unknown, encrypted values | §3, §5, §10 |
| `session/` | Frontier exchange and diff between two peers | §6 |
| `signatures/` | Ed25519 op signatures, domain separation, and the tampering cases that must be rejected | §12 |

`merge/` has its own stricter contract — the ordering matrix below. The other
directories are straightforward case lists whose shape is documented in each
file.

## Merge vector format

Each file in `merge/` is a JSON object:

```jsonc
{
  "name": "concurrent-cell-edits",
  "description": "what rule this pins down, and why",
  "ops": [ /* operations, in an arbitrary order */ ],
  "expectedState": {
    "<table>": { "<rowId>": { "<column>": <value> } }
  },
  "expectedFrontier": { "<deviceId>": "<highest hlc seen from that device>" }
}
```

- `ops` — a batch of operations exactly as they appear on the wire (§3).
- `expectedState` — the materialized state after applying them. Tombstoned
  rows are absent. Cells whose winning value is `null` are absent. Rows with
  no visible cells are absent.
- `expectedFrontier` — the version vector afterwards (§6).

## What a conforming implementation must do

For **every** vector, apply the operations and compare against
`expectedState` and `expectedFrontier` — in each of these orderings:

1. as given
2. reversed
3. at least two independent shuffles
4. shuffled with every operation duplicated
5. one operation at a time, in a shuffled order

All five must produce identical results. This is the practical expression of
the core guarantee: merge is commutative, associative, and idempotent, so
delivery order, duplication, and batching cannot affect the outcome.

The reference implementation runs exactly this matrix — see
`packages/core/test/conformance.test.ts`, and `packages/adapter-idb/test/`
which runs the same vectors against a completely different storage engine.

## Current vectors

| File | Pins down |
|---|---|
| `hlc/01-encoding.json` | Fixed-width lowercase hex encoding; bytewise string order equals logical order; malformed strings rejected |
| `hlc/02-send-receive.json` | Send and receive rules, counter overflow rollover, and drift rejection at and beyond the limit |
| `canonical/01-rfc8785.json` | RFC 8785, including UTF-16 key ordering, ECMAScript number forms, and escape choices |
| `session/01-two-party-catchup.json` | Which ops a peer must send for a given advertised frontier, and the state both peers converge on |
| `signatures/01-op-signatures.json` | Signatures over canonical JSON with domain separation; seven tampering cases that must all be refused |
| `merge/01-concurrent-cell-edits.json` | Cell-level (not row-level) conflict resolution: concurrent edits to different columns both survive |
| `merge/02-same-cell-lww-tiebreak.json` | Same-cell LWW by HLC, including the deviceId tiebreak at identical timestamps |
| `merge/03-tombstones.json` | Deleted rows stay hidden even against later higher-HLC cell writes; un-deletion restores surviving cells |
| `merge/04-null-and-unknown.json` | `null` clears a cell; unknown tables/columns are preserved and forwarded (§10) |
| `merge/05-encrypted-values.json` | Encrypted spaces merge without decryption: a keyless peer applies LWW correctly and keeps ciphertext byte-exact |

## Note on encrypted vectors

Vector 05 is applied by an implementation **without** the key, so
`expectedState` contains raw `e1:` envelopes. That is the point: merge must
never require decryption, which is what allows keyless relays and future
partial-sync peers to participate.

## Adding vectors

New vectors are welcome, especially ones that encode a rule you found
ambiguous while implementing. A good vector:

- pins down exactly one rule, and says which section of `PROTOCOL.md` it comes from
- includes operations in a deliberately unhelpful order
- uses realistic HLC strings so string-comparison ordering is exercised

## Not yet covered

- **Compaction outcomes (§9).** These depend on recorded peer frontiers rather
  than on ops alone, so a vector has to describe a whole replica's history
  rather than a batch. Contributions welcome. Until then: a replica that never
  compacts is correct, only larger, so this does not block interoperability.

Clock drift (§4.5) and the sync session (§6) were listed here and are now
covered by `hlc/02-send-receive.json` and `session/`. The drift vectors carry
an explicit `pt` field so the receiving implementation can be driven with a
fixed clock instead of reading the host's.
