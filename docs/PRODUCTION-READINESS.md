# Production readiness

What stands between today and "a user installs this and ships it".

Audited 2026-08-17 against the state of `main`. Progress tracked inline;
items are struck through as they land. Everything here was checked
against the code rather than recalled, and each item says how it was found.

---

## 0. The one that changes the plan

### Any peer who knows a space name can delete everything in it

Not a bug in the implementation — a gap in the protocol.

- The signaling server (115 lines) has **no authentication, no authorisation,
  no origin check, no rate limiting and no payload cap**. `join` takes a space
  name and a device id, both self-asserted.
- `PROTOCOL.md` never states who is *allowed* to write to a space. There is no
  notion of an authorised writer.
- Encryption does not close this. §7.2 makes row tombstones **plaintext on
  purpose**, so that keyless relays can still order deletes. A peer with no key
  therefore cannot read your data — but *can* write tombstones for every row it
  observes and delete the lot.

So a space name is a bearer credential with no revocation, and the worst case
is silent, replicated, permanent data loss.

**Partly addressed.** Phase 1 shipped in protocol v0.2: operations are signed
and identities are derived from keys, so ops cannot be forged and a device
cannot be impersonated. See §12 of `PROTOCOL.md`.

**The attack itself is still open.** Signatures prove *who* wrote an op, not
that they were permitted to. Any peer can generate a keypair and tombstone
everything. That is phase 2 — a membership roster rooted in the space
creator's key — and until it exists a space name remains a bearer credential.

This still blocks calling the system production-ready for end users. Options, roughly in increasing order of
work:

1. **Document it as the threat model.** Space names must be high-entropy and
   secret; the signaling server must be private. Cheapest, and honest, but
   leaves users one leaked name from destruction.
2. **Authenticate at the relay.** A shared token on `join`. Stops strangers
   joining, but any legitimate peer can still wipe the space, and it puts trust
   back in a server the design deliberately keeps dumb.
3. **Sign operations.** Each device holds a keypair; ops carry a signature;
   peers reject ops from unknown devices. Solves it properly and end-to-end,
   costs a protocol version and a device-authorisation flow (pairing, trust on
   first use, revocation).

Recommendation: (1) immediately, since it is documentation and true today, and
(3) as the v0.2 protocol goal. (2) is a half-measure that buys little.

---

## 1. Nothing is published

Users cannot install any of this.

| Ecosystem | State |
|---|---|
| npm | **0 of 10 packages published.** `npm view tangentfeed` → 404 |
| pub.dev | **0 of 2 published.** Install is by git dependency only |

~~Blocking the npm publish:~~ **Cleared.**

- ~~No `LICENSE` file in any package.~~ All ten now ship MIT in the tarball,
  and `files` includes it.
- ~~No `CHANGELOG.md`.~~ A single root `CHANGELOG.md` covers the monorepo,
  which shares one version across all packages. Ten near-identical per-package
  files would have been noise.
- ~~No `engines` field.~~ All ten declare `node >= 20`.
- Versions bumped to **0.2.0** to match the protocol. Publishing packages
  numbered 0.1.0 that speak protocol v0.2 would have misrepresented them for as
  long as they existed on the registry.

Still open: **no release tooling.** Bumping, tagging and publishing twelve
packages is manual. Acceptable for a first release; painful by the third.

Not blocking: packing works (`@tangentfeed/core` → 14.1 kB, 4 files), and no
package is marked private.

---

## 2. ~~There is no CI~~ — added

`.github/workflows/ci.yml` runs on push and pull request:

- **TypeScript** — `npm ci`, build, the full suite, and a check that every
  package actually produced the `main` file it advertises. A package that
  builds but emits nothing should fail here, not at `npm publish`.
- **Conformance** — regenerating the signature vectors must be a no-op. A
  generator that has drifted from its committed output is worse than no
  generator, because the files stop being reproducible by anyone else.

The **Dart job is written but disabled** (`if: false`). `impl/dart` predates
protocol v0.2 and fails against the regenerated vectors. Enabling a knowingly
red job teaches everyone to ignore the tick, which is worse than not running
it. Remove that line once the port lands.

---

## 3. Known correctness gaps

~~The Dart implementation lagging protocol v0.2~~ — ported; 137 tests green and
the Dart CI job is enabled.

| Gap | Where | Consequence |
|---|---|---|
| Compaction has no conformance vectors | protocol + both implementations | The subtlest logic in the system is unverified across implementations |
| Compaction not implemented in Dart | `impl/dart` | Dart replicas grow without bound |
| Crash-atomicity untested on sqflite | `impl/flutter` | The §8.2 guarantee is proven for `package:sqlite3` only; a phone dying mid-write is exactly when it matters |
| No typed schema layer in Dart | `impl/dart` | Feature parity gap, not a correctness risk |
| Widget bindings untested | `impl/flutter` | Written, analyse clean, never run |

---

## 4. NAT traversal — configurable now, still unproven

**Fixed:** the TypeScript transport had *no* `iceServers` default at all, so it
could not traverse any NAT. It now defaults to public STUN, matching Flutter.
Both transports accept TURN configuration, and `docs/TURN.md` covers running
coturn, the `denied-peer-ip` rules that stop a TURN server becoming a pivot
into your private network, and why static credentials in an app bundle are
published credentials.

**Still open:** no TURN server has been run against either implementation and
no cross-network sync has been demonstrated. Roughly 10–20% of real connections
need a relay, and the failure mode is silence — fine on your LAN, never
connects for a user elsewhere.

The check that settles it is in `docs/TURN.md`: set
`iceTransportPolicy: "relay"` and confirm sync still works. That forces the
relay path instead of letting ICE quietly succeed via a direct one.

---

## 5. Operational gaps in the signaling server

Beyond authentication (§0), for anything internet-facing:

- No TLS termination guidance (`ws://` is what every example shows)
- No rate limiting or connection cap — one client can exhaust it
- No maximum payload size
- No health endpoint, metrics, or structured logs
- No deployment documentation: no systemd unit, no container image

---

## 6. Documentation and developer experience

- **No API reference.** READMEs only; no generated TypeDoc or dartdoc.
- **The website documents only the TypeScript implementation.** A Flutter user
  arriving at tangentfeed.com finds nothing about Dart.
- **No upgrade or migration guidance**, which matters more than usual because
  the protocol is explicitly pre-1.0 and the format may change.
- **No security policy** (`SECURITY.md`) or disclosure contact.
- **No contribution guide**, though `conformance/IMPLEMENTING.md` covers the
  hardest part of contributing.

---

## 7. Dependency hygiene

`npm audit --omit=dev` → **0 vulnerabilities.** Nothing ships to users with a
known issue.

`npm audit` including dev → 5 (1 critical, 1 high, 3 moderate), all in `vite`,
`vitest` and `esbuild`. Dev-only and not in any published artifact, but they
surface in every audit a prospective user runs and are worth clearing.

---

## Suggested order

1. **Threat model documented** (§0 option 1) — hours, and it is true today
2. **CI** (§2) — restores the safety net everything else depends on
3. **Licences, changelogs, engines, release process** (§1) — unblocks publishing
4. **Publish to npm and pub.dev** (§1)
5. **TURN support and a cross-network test** (§4) — without this, "peer to peer" is a LAN claim
6. **Compaction vectors, then Dart compaction** (§3)
7. **Signaling server hardening and deployment docs** (§5)
8. **Signed operations** (§0 option 3) — the v0.2 protocol goal
9. Docs, API reference, website coverage (§6)
10. Dev dependency updates (§7)
