/**
 * HLC conformance vectors (§4).
 *
 * Encoding and ordering are what let every other part of the system treat an
 * HLC as an opaque sortable string, so they are pinned as data rather than
 * only as prose.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HybridLogicalClock,
  ClockDriftError,
  encodeHlc,
  decodeHlc,
  compareHlc,
} from "../src/hlc.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../conformance/hlc");

const encoding = JSON.parse(readFileSync(join(DIR, "01-encoding.json"), "utf8")) as {
  encode: { description: string; hlc: { millis: number; counter: number; deviceId: string }; expected: string }[];
  compare: { description: string; a: string; b: string; expected: number }[];
  invalid: { description: string; input: string }[];
};

const algebra = JSON.parse(readFileSync(join(DIR, "02-send-receive.json"), "utf8")) as {
  deviceId: string;
  send: {
    description: string;
    state: { millis: number; counter: number };
    pt: number;
    expected: { millis: number; counter: number };
  }[];
  receive: {
    description: string;
    state: { millis: number; counter: number };
    pt: number;
    remote: { millis: number; counter: number };
    expected?: { millis: number; counter: number };
    expectedError?: string;
  }[];
};

const sign = (n: number) => (n === 0 ? 0 : n > 0 ? 1 : -1);

describe("HLC encoding vectors", () => {
  for (const c of encoding.encode) {
    it(`encodes: ${c.description}`, () => {
      expect(encodeHlc(c.hlc)).toBe(c.expected);
    });
    it(`round-trips: ${c.description}`, () => {
      expect(decodeHlc(encodeHlc(c.hlc))).toEqual(c.hlc);
    });
  }

  for (const c of encoding.compare) {
    it(`compares: ${c.description}`, () => {
      expect(sign(compareHlc(decodeHlc(c.a), decodeHlc(c.b)))).toBe(c.expected);
    });

    it(`bytewise string order agrees with logical order: ${c.description}`, () => {
      const bytewise = c.a < c.b ? -1 : c.a > c.b ? 1 : 0;
      expect(bytewise).toBe(c.expected);
    });
  }

  for (const c of encoding.invalid) {
    it(`rejects: ${c.description}`, () => {
      expect(() => decodeHlc(c.input)).toThrow();
    });
  }
});

describe("HLC algebra vectors", () => {
  const clockAt = (state: { millis: number; counter: number }, pt: number) =>
    new HybridLogicalClock({
      deviceId: algebra.deviceId,
      millis: state.millis,
      counter: state.counter,
      physicalClock: () => pt,
    });

  for (const c of algebra.send) {
    it(`send: ${c.description}`, () => {
      const got = clockAt(c.state, c.pt).now();
      expect({ millis: got.millis, counter: got.counter }).toEqual(c.expected);
    });
  }

  for (const c of algebra.receive) {
    it(`receive: ${c.description}`, () => {
      const clock = clockAt(c.state, c.pt);
      const remote = { ...c.remote, deviceId: "ffffffffffffffff" };

      if (c.expectedError === "CLOCK_DRIFT") {
        expect(() => clock.receive(remote)).toThrow(ClockDriftError);
        return;
      }

      const got = clock.receive(remote);
      expect({ millis: got.millis, counter: got.counter }).toEqual(c.expected);
    });
  }

  it("receive always yields a clock strictly greater than both inputs", () => {
    for (const c of algebra.receive) {
      if (c.expectedError) continue;
      const remote = { ...c.remote, deviceId: "ffffffffffffffff" };
      const before = { ...c.state, deviceId: algebra.deviceId };
      const after = clockAt(c.state, c.pt).receive(remote);
      expect(compareHlc(after, before)).toBeGreaterThan(0);
      expect(compareHlc(after, remote)).toBeGreaterThan(0);
    }
  });
});
