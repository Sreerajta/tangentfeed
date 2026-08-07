/**
 * BroadcastChannel transport — same-origin, same-device sync (tabs, workers).
 *
 * BroadcastChannel is already a bus with exactly our Transport semantics:
 * postMessage reaches every other listener on the channel name, never
 * ourselves. Structured clone carries WireMsg objects natively. This file
 * being ~30 lines is the proof the Transport interface is cut right; the
 * WebRTC transport (M4) implements the same four members.
 *
 * Works in browsers and in Node ≥18 (worker_threads-backed), which is why the
 * tests need no mocks.
 */

import type { Transport, WireMsg } from "@tangentfeed/core";

export class BroadcastTransport implements Transport {
  private readonly channel: BroadcastChannel;
  private readonly listeners = new Set<(msg: WireMsg) => void>();

  constructor(space: string) {
    this.channel = new BroadcastChannel(`tangentfeed:${space}`);
    this.channel.onmessage = (ev: MessageEvent) => {
      for (const cb of this.listeners) cb(ev.data as WireMsg);
    };
  }

  send(msg: WireMsg): void {
    this.channel.postMessage(msg);
  }

  onMessage(cb: (msg: WireMsg) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): void {
    this.listeners.clear();
    this.channel.close();
  }
}
