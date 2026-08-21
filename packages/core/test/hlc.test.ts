import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  HybridLogicalClock,
  ClockDriftError,
  encodeHlc,
  decodeHlc,
  compareHlc,
  isValidDeviceId,
  MAX_COUNTER,
  MAX_DRIFT_MS,
  type Hlc,
} from "../src/hlc.js";
import { deviceIdFromPublicKey, generateDeviceKey } from "../src/signing.js";

// ---------- arbitraries ----------

// 16 bytes, not 8: deviceId widened to 128 bits when it became the thing a
// signature is checked against (§4.3).
const arbDeviceId = fc
  .uint8Array({ minLength: 16, maxLength: 16 })
  .map((b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));

// millis capped at 2^46 (~year 4200): any HLC beyond a real clock + MAX_DRIFT
// is rejected at the receive boundary (§4.5), so timestamps near the 48-bit
// encoding ceiling are unreachable in a conforming system. Found by fast-check.
const arbHlc: fc.Arbitrary<Hlc> = fc.record({
  millis: fc.integer({ min: 0, max: 2 ** 46 }),
  counter: fc.integer({ min: 0, max: MAX_COUNTER }),
  deviceId: arbDeviceId,
});

/**
 * A controllable physical clock. `deltas` drive successive readings; the
 * clock can stall (0) or go BACKWARDS (negative delta), which is exactly
 * the hostile environment HLC must survive.
 */
function makePhysicalClock(start: number, deltas: number[]) {
  let t = start;
  let i = 0;
  return () => {
    if (i < deltas.length) {
      t += deltas[i]!;
      i += 1;
    }
    return Math.max(0, t);
  };
}

const arbDeltas = fc.array(fc.integer({ min: -5_000, max: 5_000 }), {
  minLength: 1,
  maxLength: 200,
});

// ---------- encoding ----------

describe("encoding", () => {
  it("round-trips (decode ∘ encode = id)", () => {
    fc.assert(
      fc.property(arbHlc, (h) => {
        expect(decodeHlc(encodeHlc(h))).toEqual(h);
      }),
    );
  });

  it("is fixed-width 50 chars", () => {
    fc.assert(
      fc.property(arbHlc, (h) => {
        expect(encodeHlc(h)).toHaveLength(50);
      }),
    );
  });

  it("rejects malformed strings", () => {
    for (const bad of [
      "",
      "zzz",
      "018f6e2a9c40-0003-a1b2c3d4e5f60718", // v0.1 width, too short now
      "018f6e2a9c40-0003-A1B2C3D4E5F60718A1B2C3D4E5F60718", // uppercase
      "018f6e2a9c400003a1b2c3d4e5f60718a1b2c3d4e5f60718", // no dashes
    ]) {
      expect(() => decodeHlc(bad)).toThrow();
    }
  });

  it("PROTOCOL §4.2: lexicographic order of encoded strings === compareHlc", () => {
    fc.assert(
      fc.property(arbHlc, arbHlc, (a, b) => {
        const structural = Math.sign(compareHlc(a, b));
        const ea = encodeHlc(a);
        const eb = encodeHlc(b);
        const lexical = ea < eb ? -1 : ea > eb ? 1 : 0;
        expect(lexical).toBe(structural);
      }),
    );
  });
});

// ---------- compareHlc: total order laws ----------

describe("compareHlc total order", () => {
  it("antisymmetry: compare(a,b) === -compare(b,a)", () => {
    fc.assert(
      fc.property(arbHlc, arbHlc, (a, b) => {
        expect(compareHlc(a, b)).toBe(-compareHlc(b, a));
      }),
    );
  });

  it("transitivity: a<=b and b<=c implies a<=c", () => {
    fc.assert(
      fc.property(arbHlc, arbHlc, arbHlc, (x, y, z) => {
        const [a, b, c] = [x, y, z].sort(compareHlc) as [Hlc, Hlc, Hlc];
        expect(compareHlc(a, b)).toBeLessThanOrEqual(0);
        expect(compareHlc(b, c)).toBeLessThanOrEqual(0);
        expect(compareHlc(a, c)).toBeLessThanOrEqual(0);
      }),
    );
  });

  it("equality only for identical triples; deviceId breaks ties", () => {
    fc.assert(
      fc.property(arbHlc, arbDeviceId, (h, otherDevice) => {
        fc.pre(otherDevice !== h.deviceId);
        expect(compareHlc(h, h)).toBe(0);
        expect(compareHlc(h, { ...h, deviceId: otherDevice })).not.toBe(0);
      }),
    );
  });
});

// ---------- now(): monotonicity under hostile clocks ----------

describe("now()", () => {
  it("is strictly increasing even when the wall clock stalls or runs backwards", () => {
    fc.assert(
      fc.property(
        arbDeviceId,
        fc.integer({ min: 0, max: 2 ** 40 }),
        arbDeltas,
        (deviceId, start, deltas) => {
          const clk = new HybridLogicalClock({
            deviceId,
            physicalClock: makePhysicalClock(start, deltas),
          });
          let prev: Hlc | null = null;
          for (let i = 0; i < deltas.length; i++) {
            const t = clk.now();
            if (prev) expect(compareHlc(prev, t)).toBeLessThan(0);
            prev = t;
          }
        },
      ),
    );
  });

  it("issues unique timestamps under a completely frozen clock (counter path)", () => {
    const clk = new HybridLogicalClock({
      deviceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      physicalClock: () => 1_000,
    });
    const seen = new Set<string>();
    for (let i = 0; i < 70_000; i++) {
      // > MAX_COUNTER iterations forces the overflow rollover path
      seen.add(encodeHlc(clk.now()));
    }
    expect(seen.size).toBe(70_000);
  });

  it("counter overflow rolls into millis (§4.1)", () => {
    const clk = new HybridLogicalClock({
      deviceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      physicalClock: () => 500,
      millis: 500,
      counter: MAX_COUNTER,
    });
    const t = clk.now();
    expect(t.millis).toBe(501);
    expect(t.counter).toBe(0);
  });
});

// ---------- receive(): causality ----------

describe("receive()", () => {
  it("result is strictly greater than both previous local state and remote", () => {
    fc.assert(
      fc.property(
        arbDeviceId,
        arbHlc,
        fc.integer({ min: 0, max: 2 ** 40 }),
        fc.integer({ min: 0, max: MAX_COUNTER }),
        fc.integer({ min: -60_000, max: 60_000 }),
        (deviceId, remote, localMillis, localCounter, physOffset) => {
          // physical clock near the remote's millis, within drift bounds
          const phys = Math.max(0, remote.millis + physOffset);
          fc.pre(remote.millis <= phys + MAX_DRIFT_MS);
          const clk = new HybridLogicalClock({
            deviceId,
            physicalClock: () => phys,
            millis: localMillis,
            counter: localCounter,
          });
          const before = clk.state();
          const after = clk.receive(remote);
          expect(compareHlc(before, after)).toBeLessThan(0);
          expect(compareHlc(remote, after)).toBeLessThan(0);
        },
      ),
    );
  });

  it("a reply written after receive() sorts after the received op (causality)", () => {
    fc.assert(
      fc.property(arbDeviceId, arbDeviceId, arbHlc, (devA, devB, seed) => {
        fc.pre(devA !== devB);
        // A issues an op; B (with an arbitrary lagging clock) receives it,
        // then writes. B's write must sort after A's op.
        const a = new HybridLogicalClock({
          deviceId: devA,
          physicalClock: () => seed.millis,
          millis: seed.millis,
          counter: seed.counter,
        });
        const opA = a.now();
        const b = new HybridLogicalClock({
          deviceId: devB,
          physicalClock: () => Math.max(0, seed.millis - 50_000), // B's clock is behind
        });
        b.receive(opA);
        const opB = b.now();
        expect(compareHlc(opA, opB)).toBeLessThan(0);
      }),
    );
  });

  it("rejects timestamps more than MAX_DRIFT ahead (§4.5)", () => {
    const clk = new HybridLogicalClock({
      deviceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      physicalClock: () => 1_000_000,
    });
    const evil: Hlc = {
      millis: 1_000_000 + MAX_DRIFT_MS + 1,
      counter: 0,
      deviceId: "bbbbbbbbbbbbbbbb",
    };
    expect(() => clk.receive(evil)).toThrow(ClockDriftError);
    // exactly at the boundary is allowed
    const boundary: Hlc = { ...evil, millis: 1_000_000 + MAX_DRIFT_MS };
    expect(() => clk.receive(boundary)).not.toThrow();
  });
});

// ---------- multi-clock simulation: the property that matters ----------

describe("simulation: N devices exchanging timestamps", () => {
  it("HLC order never contradicts causal history, under skewed drifting clocks", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }), // device count
        fc.array(
          fc.record({
            actor: fc.nat(4),
            kind: fc.constantFrom<"local" | "sync">("local", "sync"),
            target: fc.nat(4),
            drift: fc.integer({ min: -30_000, max: 30_000 }),
          }),
          { minLength: 10, maxLength: 150 },
        ),
        (n, events) => {
          const base = 1_700_000_000_000;
          let step = 0;
          const clocks = Array.from({ length: n }, (_, i) => {
            const skew = ((i * 7919) % 20_000) - 10_000; // fixed per-device skew
            return new HybridLogicalClock({
              deviceId: i.toString(16).padStart(32, "0"),
              physicalClock: () => base + step * 10 + skew,
            });
          });
          // happened-before tracking: for each issued timestamp, the set of
          // timestamps causally before it must all compare less.
          const issued: { ts: Hlc; after: Hlc[] }[] = [];
          const knownBy: Hlc[][] = Array.from({ length: n }, () => []);

          for (const ev of events) {
            step += 1;
            const i = ev.actor % n;
            if (ev.kind === "local") {
              const ts = clocks[i]!.now();
              issued.push({ ts, after: [...knownBy[i]!] });
              knownBy[i]!.push(ts);
            } else {
              const j = ev.target % n;
              if (i === j) continue;
              const latest = knownBy[j]!.at(-1);
              if (!latest) continue;
              try {
                clocks[i]!.receive(latest);
              } catch (e) {
                if (e instanceof ClockDriftError) continue; // fine: rejected
                throw e;
              }
              knownBy[i]!.push(latest);
            }
          }

          for (const { ts, after } of issued) {
            for (const prior of after) {
              expect(compareHlc(prior, ts)).toBeLessThan(0);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------- deviceId ----------

describe("deviceId", () => {
  it("accepts a derived id", () => {
    // Identity comes from a key now (§4.3); the only thing left to check is
    // that what we derive is what we accept.
    for (let i = 0; i < 100; i++) {
      expect(isValidDeviceId(deviceIdFromPublicKey(generateDeviceKey().publicKey))).toBe(true);
    }
  });

  it("constructor rejects invalid deviceIds", () => {
    for (const bad of ["", "short", "A1B2C3D4E5F60718", "a1b2c3d4e5f6071g", "a1b2c3d4e5f60718"]) {
      expect(
        () => new HybridLogicalClock({ deviceId: bad }),
      ).toThrow();
    }
  });
});
