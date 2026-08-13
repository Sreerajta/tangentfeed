# tangentfeed — build roadmap

A protocol + implementations for offline-first, P2P data sync.
Cell-level LWW over an HLC-ordered op log. Any storage, any transport, any language.

- `PROTOCOL.md` — the spec (v0.1 draft). This is the product.
- `packages/core` — TypeScript reference implementation.

## Milestones

- [x] M0 — Protocol spec v0.1 + HLC with property tests (16 tests, fast-check)
- [x] M1 — Core engine: oplog, cell-level LWW, tombstones, frontier sync, subscriptions; convergence property suite + 4 conformance vectors (55 tests total)
- [x] M2 — IndexedDB adapter (conformance vectors pass on IDB, persistence across reopen, cross-adapter interop) + self-contained browser demo (apps/demo/dist/index.html)
- [x] M3 — Transport interface + Replicator (§6 session: hello/since/ops/ack, live tail, echo-safe) + BroadcastChannel transport; live tab-to-tab demo
- [x] M4 — Signaling server (blind relay, presence, ~120 lines) + WebRTC transport (deterministic initiator roles, trickle ICE, reconnect w/ backoff); 5 end-to-end tests over REAL DataChannels incl. 3-peer mesh + offline heal; cross-device browser demo (dist/webrtc.html)
- [x] M5 — Offline queue + reconnect (proven by offline-heal e2e tests in M3 broadcast + M4 webrtc suites; frontier exchange made it free)
- [x] M6 — ManualPairTransport: non-trickle offer/answer blobs (base64url, QR-safe), 4 e2e tests over real DataChannels; QR pairing demo w/ camera scan (dist/manual.html)
- [x] M7 — E2E encryption: Cipher interface in core (still zero-dep) + @tangentfeed/crypto (XChaCha20-Poly1305, HKDF, scrypt passphrases); AAD binds ciphertext to op id; tombstones stay plaintext so keyless peers still merge; PROTOCOL.md §7 fully spec'd; 15 tests + conformance vector
- [x] M8 — Compaction: horizon from recorded peer frontiers, superseded-op reclamation, opt-in whole-row tombstone GC (resurrection-safe), dry run + blockedBy reporting; 12 tests incl. convergence-under-compaction property + soak (10150 ops → 150)
- [~] M9 — Dogfood: skipped as planned (TangentFlow already shipped to store). Replaced by building all three demo apps on the public API, which validated packaging the same way.
- [x] M10 — Publish: 8 packages with ESM + type declarations, `tangentfeed` batteries-included entry point (`openSpace`), `@tangentfeed/react` hooks, README + per-package docs, conformance suite contract, LICENSE; verified by installing built tarballs into a clean project

## Run tests

```
npm install
npm test
```

## Post-v0.1

- [x] SQLite adapter (`@tangentfeed/adapter-sqlite`): driver-agnostic (better-sqlite3 / node:sqlite / bun:sqlite), real queryable tables, `BEGIN IMMEDIATE` atomicity, 14 tests incl. conformance vectors and on-disk persistence; Node CLI peer demo in `apps/node-demo`

- [x] Renamed from `syncdb` to `tangentfeed` before first publish. Normative identifiers (HKDF info string, data channel label, storage prefix) changed with it; see PROTOCOL.md.

- [x] Typed schema layer (`@tangentfeed/schema`): field DSL with inference,
  local write validation with defaults, `parseRow` for opt-in checking of
  foreign rows; zero runtime dependencies, core untouched. Includes an
  op-stream equivalence test proving the layer cannot perturb the wire format.
