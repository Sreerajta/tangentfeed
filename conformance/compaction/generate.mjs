/**
 * Generates the compaction vectors.
 *
 *   node conformance/compaction/generate.mjs > conformance/compaction/01-compaction.json
 *
 * Compaction is the one part of the protocol whose outcome depends on a whole
 * replica's history rather than a batch of ops: the horizon comes from
 * recorded peer frontiers (§9). A vector therefore carries the log AND the
 * peer frontiers, not just operations.
 *
 * Keys are the shared conformance identities, so a harness that already loads
 * test-keys.json needs nothing new.
 */

import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";

const keys = JSON.parse(readFileSync("conformance/test-keys.json", "utf8")).keys;
const ids = Object.keys(keys);
const [A, B] = ids;

const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
const DOMAIN = "tangentfeed/v2/op";

function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return (
    "{" +
    Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") +
    "}"
  );
}

const hlc = (millis, counter, device) =>
  `${millis.toString(16).padStart(12, "0")}-${counter.toString(16).padStart(4, "0")}-${device}`;

function op({ millis, counter = 0, device, table = "tasks", row, column, value }) {
  const h = hlc(millis, counter, device);
  const rest = { id: h, table, row, column, value, hlc: h, device };
  const sig = Buffer.from(
    ed25519.sign(
      new TextEncoder().encode(DOMAIN + canonicalJson(rest)),
      unhex(keys[device].privateKey),
    ),
  ).toString("base64");
  return { ...rest, sig };
}

const ROW1 = "01HZX3NDEKTSV4RRFFQ69G5FAA";
const ROW2 = "01HZX3NDEKTSV4RRFFQ69G5FBB";
const T = 0x018bcfe56800;

// ---- vector 1: superseded values are reclaimed once every peer has them ----
const supersededOps = [
  op({ millis: T + 0, device: A, row: ROW1, column: "title", value: "first" }),
  op({ millis: T + 1, device: A, row: ROW1, column: "title", value: "second" }),
  op({ millis: T + 2, device: A, row: ROW1, column: "title", value: "third" }),
];

const superseded = {
  name: "superseded-values-reclaimed",
  description:
    "Three writes to one cell; only the last is the winner. With every peer's " +
    "frontier past all three, the two losers are droppable. Materialized state " +
    "must be identical before and after — that is the invariant that makes " +
    "compaction safe at all.",
  ops: supersededOps,
  peerFrontiers: { [B]: { [A]: supersededOps[2].hlc } },
  options: { includeTombstones: false },
  expected: {
    removed: 2,
    rowsReclaimed: 0,
    blockedBy: [],
    opCountAfter: 1,
    stateUnchanged: true,
  },
};

// ---- vector 2: a lagging peer pins the horizon ----
const laggingOps = [
  op({ millis: T + 0, device: A, row: ROW1, column: "title", value: "first" }),
  op({ millis: T + 1, device: A, row: ROW1, column: "title", value: "second" }),
  op({ millis: T + 2, device: A, row: ROW1, column: "title", value: "third" }),
];

const lagging = {
  name: "lagging-peer-blocks-reclamation",
  description:
    "Same log, but a peer has only acknowledged the first op, so the horizon " +
    "stops there. The first op is itself superseded AND below the horizon, so " +
    "it goes; the second cannot, because a peer that has not yet seen the " +
    "winner would be left with neither. One lagging peer is the difference " +
    "between reclaiming two ops and reclaiming one. The peer is named in " +
    "blockedBy, so a caller can see why reclamation stalled instead of " +
    "watching the log grow with no explanation.",
  ops: laggingOps,
  peerFrontiers: { [B]: { [A]: laggingOps[0].hlc } },
  options: { includeTombstones: false },
  expected: {
    removed: 1,
    rowsReclaimed: 0,
    blockedBy: [B],
    opCountAfter: 2,
    stateUnchanged: true,
  },
};

// ---- vector 3: tombstoned rows survive by default ----
const tombOps = [
  op({ millis: T + 0, device: A, row: ROW1, column: "title", value: "doomed" }),
  op({ millis: T + 1, device: A, row: ROW1, column: "-", value: true }),
  op({ millis: T + 2, device: A, row: ROW2, column: "title", value: "survivor" }),
];

const tombstoneDefault = {
  name: "tombstones-survive-by-default",
  description:
    "A deleted row is not reclaimed unless asked. §9 makes this opt-in because " +
    "a peer offline beyond the horizon can no longer learn the row was " +
    "deleted, and would resurrect it.",
  ops: tombOps,
  peerFrontiers: { [B]: { [A]: tombOps[2].hlc } },
  options: { includeTombstones: false },
  expected: {
    removed: 0,
    rowsReclaimed: 0,
    blockedBy: [],
    opCountAfter: 3,
    stateUnchanged: true,
  },
};

// ---- vector 4: opt-in tombstone GC reclaims the row whole ----
const tombstoneOptIn = {
  name: "tombstone-gc-reclaims-the-whole-row",
  description:
    "With includeTombstones, a tombstoned row below the horizon is removed " +
    "entirely: the tombstone AND every cell op of that row, together. " +
    "Dropping the tombstone while leaving the row's other cells would " +
    "resurrect the row on the very next read, which is the failure this rule " +
    "exists to prevent. The surviving row is untouched.",
  ops: tombOps,
  peerFrontiers: { [B]: { [A]: tombOps[2].hlc } },
  options: { includeTombstones: true },
  expected: {
    removed: 2,
    rowsReclaimed: 1,
    blockedBy: [],
    opCountAfter: 1,
    stateUnchanged: true,
  },
};

// ---- vector 5: with no peers, a replica is alone ----
const alone = {
  name: "no-recorded-peers-means-alone",
  description:
    "A replica that has never completed a sync has no peer frontiers, so the " +
    "horizon is its own. Correct for a genuinely single-device user, and a " +
    "further reason tombstone GC is opt-in: the horizon is only as good as the " +
    "frontiers actually recorded.",
  ops: supersededOps,
  peerFrontiers: {},
  options: { includeTombstones: false },
  expected: {
    removed: 2,
    rowsReclaimed: 0,
    blockedBy: [],
    opCountAfter: 1,
    stateUnchanged: true,
  },
};

// ---- vector 6: dry run touches nothing ----
const dryRun = {
  name: "dry-run-reports-without-removing",
  description:
    "The same numbers as the first vector, but the log is untouched afterwards.",
  ops: supersededOps,
  peerFrontiers: { [B]: { [A]: supersededOps[2].hlc } },
  options: { includeTombstones: false, dryRun: true },
  expected: {
    removed: 2,
    rowsReclaimed: 0,
    blockedBy: [],
    opCountAfter: 3,
    stateUnchanged: true,
  },
};

console.log(
  JSON.stringify(
    {
      name: "compaction",
      description:
        "Compaction outcomes (§9). Unlike merge, these depend on a whole " +
        "replica's history: the horizon is derived from recorded peer " +
        "frontiers, so each vector carries the log AND those frontiers. " +
        "`stateUnchanged` is the invariant that matters most — compaction " +
        "reclaims storage and must never alter what a reader sees.",
      vectors: [superseded, lagging, tombstoneDefault, tombstoneOptIn, alone, dryRun],
    },
    null,
    2,
  ),
);
