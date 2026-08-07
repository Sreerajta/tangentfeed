/**
 * ULID — PROTOCOL.md §4.4. 48-bit timestamp + 80-bit randomness,
 * Crockford base32, 26 chars, canonical uppercase. No dependencies.
 */

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(
  time: number = Date.now(),
  randomBytes: (n: number) => Uint8Array = defaultRandomBytes,
): string {
  if (!Number.isInteger(time) || time < 0 || time > 2 ** 48 - 1) {
    throw new Error(`ulid: time out of range: ${time}`);
  }
  // 10 chars of time (48 bits, 5 bits per char = 50; top 2 bits zero)
  let t = time;
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = B32[t % 32]!;
    t = Math.floor(t / 32);
  }
  // 16 chars of randomness (80 bits)
  const rand = randomBytes(10);
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of rand) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  // 80 bits / 5 = 16 chars exactly, no remainder
  return timeChars.join("") + out;
}

function defaultRandomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}
