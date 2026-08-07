# Conformance suite

Language-neutral test vectors for the tangentfeed protocol. An implementation in any
language that passes these is interoperable with any other that does.

This directory is the contract. `PROTOCOL.md` explains the rules in prose;
these files pin them down as data.

## Format

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
| `01-concurrent-cell-edits.json` | Cell-level (not row-level) conflict resolution: concurrent edits to different columns both survive |
| `02-same-cell-lww-tiebreak.json` | Same-cell LWW by HLC, including the deviceId tiebreak at identical timestamps |
| `03-tombstones.json` | Deleted rows stay hidden even against later higher-HLC cell writes; un-deletion restores surviving cells |
| `04-null-and-unknown.json` | `null` clears a cell; unknown tables/columns are preserved and forwarded (§10) |
| `05-encrypted-values.json` | Encrypted spaces merge without decryption: a keyless peer applies LWW correctly and keeps ciphertext byte-exact |

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

These rules are specified but lack vectors. Contributions welcome:

- clock drift rejection (§4.5) — needs a vector format that carries a fixed
  "current time" for the receiving implementation
- compaction outcomes (§9), which depend on peer frontiers rather than ops alone
- the sync session message exchange (§6), which needs a two-party harness
  rather than a single-replica one
