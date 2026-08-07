/**
 * Hybrid Logical Clock — PROTOCOL.md §4
 *
 * State: (millis, counter, deviceId).
 * String form: 12-hex millis + "-" + 4-hex counter + "-" + 16-hex deviceId,
 * fixed 34 chars, lexicographic order === logical order.
 */

export const MAX_COUNTER = 0xffff;
export const MAX_MILLIS = 2 ** 48 - 1;
export const MAX_DRIFT_MS = 300_000; // 5 minutes, §4.5

export interface Hlc {
  readonly millis: number;
  readonly counter: number;
  readonly deviceId: string;
}

export class ClockDriftError extends Error {
  readonly code = "CLOCK_DRIFT";
  constructor(remoteMillis: number, physicalNow: number) {
    super(
      `remote HLC is ${remoteMillis - physicalNow}ms ahead of local clock ` +
        `(max allowed ${MAX_DRIFT_MS}ms); check system time`,
    );
  }
}

const DEVICE_ID_RE = /^[0-9a-f]{16}$/;
const HLC_STRING_RE = /^[0-9a-f]{12}-[0-9a-f]{4}-[0-9a-f]{16}$/;

/** Generate a fresh 64-bit deviceId (16 lowercase hex chars). §4.3 */
export function generateDeviceId(
  randomBytes: (n: number) => Uint8Array = defaultRandomBytes,
): string {
  const b = randomBytes(8);
  let s = "";
  for (const byte of b) s += byte.toString(16).padStart(2, "0");
  return s;
}

function defaultRandomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  // globalThis.crypto exists in browsers, Node >= 19, Deno, Bun, workers.
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function isValidDeviceId(s: string): boolean {
  return DEVICE_ID_RE.test(s);
}

/** Canonical string encoding. §4.2 */
export function encodeHlc(h: Hlc): string {
  return (
    h.millis.toString(16).padStart(12, "0") +
    "-" +
    h.counter.toString(16).padStart(4, "0") +
    "-" +
    h.deviceId
  );
}

/** Parse canonical string form; throws on malformed input. */
export function decodeHlc(s: string): Hlc {
  if (!HLC_STRING_RE.test(s)) {
    throw new Error(`malformed HLC string: ${JSON.stringify(s)}`);
  }
  return {
    millis: parseInt(s.slice(0, 12), 16),
    counter: parseInt(s.slice(13, 17), 16),
    deviceId: s.slice(18),
  };
}

/**
 * Total order over HLCs: millis, then counter, then deviceId.
 * Guaranteed to agree with bytewise comparison of encodeHlc output;
 * the property tests verify this equivalence.
 */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.millis !== b.millis) return a.millis < b.millis ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  return 0;
}

/**
 * The clock itself. Owns mutable (millis, counter) state for one device in
 * one space. Inject `physicalClock` for tests; defaults to Date.now.
 *
 * Persistence: callers should persist state() after issuing ops and restore
 * with the constructor, so a restart never reissues a timestamp.
 */
export class HybridLogicalClock {
  private millis: number;
  private counter: number;
  readonly deviceId: string;
  private readonly physicalClock: () => number;

  constructor(opts: {
    deviceId: string;
    physicalClock?: () => number;
    /** restore persisted state; defaults to zero */
    millis?: number;
    counter?: number;
  }) {
    if (!isValidDeviceId(opts.deviceId)) {
      throw new Error(`invalid deviceId: ${JSON.stringify(opts.deviceId)}`);
    }
    this.deviceId = opts.deviceId;
    this.physicalClock = opts.physicalClock ?? Date.now;
    this.millis = opts.millis ?? 0;
    this.counter = opts.counter ?? 0;
    this.checkBounds();
  }

  /** Current state, for persistence. Does not advance the clock. */
  state(): Hlc {
    return { millis: this.millis, counter: this.counter, deviceId: this.deviceId };
  }

  /**
   * Issue a timestamp for a new local op. §4.1 "send/local event".
   * Strictly greater than every timestamp this clock has issued or observed.
   */
  now(): Hlc {
    const pt = this.physicalClock();
    if (pt > this.millis) {
      this.millis = pt;
      this.counter = 0;
    } else {
      this.counter += 1;
      if (this.counter > MAX_COUNTER) {
        // overflow rollover, §4.1
        this.millis += 1;
        this.counter = 0;
      }
    }
    this.checkBounds();
    return this.state();
  }

  /**
   * Observe a remote timestamp. §4.1 "receive".
   * Throws ClockDriftError if the remote is > MAX_DRIFT_MS ahead of our
   * physical clock (§4.5). On success the local clock becomes strictly
   * greater than both its previous state and the remote timestamp.
   */
  receive(remote: Hlc): Hlc {
    const pt = this.physicalClock();
    if (remote.millis > pt + MAX_DRIFT_MS) {
      throw new ClockDriftError(remote.millis, pt);
    }
    const m = Math.max(this.millis, remote.millis, pt);
    let c: number;
    if (m === this.millis && m === remote.millis) {
      c = Math.max(this.counter, remote.counter) + 1;
    } else if (m === this.millis) {
      c = this.counter + 1;
    } else if (m === remote.millis) {
      c = remote.counter + 1;
    } else {
      c = 0;
    }
    this.millis = m;
    this.counter = c;
    if (this.counter > MAX_COUNTER) {
      this.millis += 1;
      this.counter = 0;
    }
    this.checkBounds();
    return this.state();
  }

  private checkBounds(): void {
    if (this.millis > MAX_MILLIS) {
      throw new Error("HLC millis exceeded 48-bit range");
    }
  }
}
