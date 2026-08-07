/**
 * Manual pairing transport — WebRTC with zero infrastructure.
 *
 * Instead of a signaling server, two humans carry the signaling: device A
 * displays its offer as a QR code (or copyable text), device B ingests it and
 * displays an answer, A ingests that, and the DataChannel opens. Works with
 * no internet at all on a shared LAN.
 *
 * The trick that makes one-QR-per-direction possible: NON-trickle ICE. We
 * wait for candidate gathering to finish (with a timeout fallback — host
 * candidates alone are enough on a LAN) so the SDP blob contains every
 * candidate inline. Nothing else about the stack changes: this class speaks
 * the same Transport interface, so the Replicator neither knows nor cares
 * that signaling traveled by camera.
 *
 * Exactly two peers by design. Blobs are base64url(JSON) and single-use.
 */

import type { Transport, WireMsg } from "@tangentfeed/core";

export type ManualPairState =
  | "idle"
  | "gathering"
  | "waiting-for-answer"
  | "connecting"
  | "connected"
  | "failed"
  | "closed";

export interface ManualPairOptions {
  deviceId: string;
  wrtc?: { RTCPeerConnection: typeof RTCPeerConnection };
  rtcConfig?: RTCConfiguration;
  onError?: (err: unknown) => void;
  onState?: (state: ManualPairState) => void;
  /** max ms to wait for full ICE gathering before shipping what we have */
  gatherTimeoutMs?: number;
}

interface Blob1 {
  v: 1;
  kind: "offer" | "answer";
  device: string;
  /** pairing space id, minted by the offerer; the answerer adopts it */
  space: string;
  sdp: RTCSessionDescriptionInit;
}

const CHANNEL_LABEL = "tangentfeed";

export class ManualPairTransport implements Transport {
  private readonly opts: ManualPairOptions;
  private readonly RTCPC: typeof RTCPeerConnection;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private readonly msgListeners = new Set<(msg: WireMsg) => void>();
  private readonly peerConnectListeners = new Set<(peerId?: string) => void>();
  private _state: ManualPairState = "idle";
  private _space: string | null = null;
  private _peerDevice: string | null = null;

  constructor(opts: ManualPairOptions) {
    this.opts = opts;
    const rtc = opts.wrtc?.RTCPeerConnection ?? globalThis.RTCPeerConnection;
    if (!rtc) throw new Error("no RTCPeerConnection available; pass opts.wrtc");
    this.RTCPC = rtc;
  }

  get state(): ManualPairState {
    return this._state;
  }
  /** The pairing space id (offerer mints it; answerer learns it from the offer). */
  get space(): string | null {
    return this._space;
  }
  get peerDevice(): string | null {
    return this._peerDevice;
  }

  // ---------- pairing (device A) ----------

  /** Role A: create the offer blob to display as a QR / copy to the peer. */
  async createOffer(): Promise<string> {
    if (this.pc) throw new Error("pairing already in progress; create a new transport");
    this._space = "manual-" + randHex(8);
    const pc = this.newPc();
    this.attachChannel(pc.createDataChannel(CHANNEL_LABEL));
    this.setState("gathering");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.gathered(pc);
    this.setState("waiting-for-answer");
    return encodeBlob({
      v: 1,
      kind: "offer",
      device: this.opts.deviceId,
      space: this._space,
      sdp: pc.localDescription ?? offer,
    });
  }

  /** Role A: ingest the answer blob the peer displayed. */
  async acceptAnswer(blob: string): Promise<void> {
    const msg = decodeBlob(blob);
    if (msg.kind !== "answer") throw new Error("expected an ANSWER blob, got an offer — paste it on the other device");
    if (!this.pc) throw new Error("no pending offer; call createOffer first");
    this._peerDevice = msg.device;
    this.setState("connecting");
    await this.pc.setRemoteDescription(msg.sdp);
  }

  // ---------- pairing (device B) ----------

  /** Role B: ingest an offer blob; returns the answer blob to display back. */
  async acceptOffer(blob: string): Promise<string> {
    if (this.pc) throw new Error("pairing already in progress; create a new transport");
    const msg = decodeBlob(blob);
    if (msg.kind !== "offer") throw new Error("expected an OFFER blob, got an answer");
    this._space = msg.space;
    this._peerDevice = msg.device;
    const pc = this.newPc();
    pc.ondatachannel = (ev) => this.attachChannel(ev.channel);
    this.setState("gathering");
    await pc.setRemoteDescription(msg.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.gathered(pc);
    this.setState("connecting");
    return encodeBlob({
      v: 1,
      kind: "answer",
      device: this.opts.deviceId,
      space: msg.space,
      sdp: pc.localDescription ?? answer,
    });
  }

  // ---------- Transport interface ----------

  send(msg: WireMsg): void {
    if (this.channel?.readyState === "open") {
      try {
        this.channel.send(JSON.stringify(msg));
      } catch (err) {
        this.opts.onError?.(err);
      }
    }
  }

  onMessage(cb: (msg: WireMsg) => void): () => void {
    this.msgListeners.add(cb);
    return () => this.msgListeners.delete(cb);
  }

  onPeerConnect(cb: (peerId?: string) => void): () => void {
    this.peerConnectListeners.add(cb);
    return () => this.peerConnectListeners.delete(cb);
  }

  close(): void {
    this.setState("closed");
    try {
      this.channel?.close();
    } catch {
      /* already closed */
    }
    try {
      this.pc?.close();
    } catch {
      /* already closed */
    }
    this.channel = null;
    this.pc = null;
    this.msgListeners.clear();
    this.peerConnectListeners.clear();
  }

  // ---------- internals ----------

  private newPc(): RTCPeerConnection {
    const pc = new this.RTCPC(this.opts.rtcConfig ?? {});
    this.pc = pc;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.setState("connected");
      if (["failed", "closed"].includes(pc.connectionState)) {
        if (this._state !== "closed") this.setState("failed");
      }
    };
    return pc;
  }

  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.onopen = () => {
      this.setState("connected");
      for (const cb of this.peerConnectListeners) cb(this._peerDevice ?? undefined);
    };
    channel.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WireMsg;
        for (const cb of this.msgListeners) cb(msg);
      } catch (err) {
        this.opts.onError?.(err);
      }
    };
    channel.onclose = () => {
      if (this._state !== "closed") this.setState("failed");
    };
  }

  /** Resolve when ICE gathering completes, or after the timeout with whatever
   * candidates exist (host candidates suffice on a LAN). */
  private gathered(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    const timeoutMs = this.opts.gatherTimeoutMs ?? 2500;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      const check = () => {
        if (pc.iceGatheringState === "complete") done();
      };
      pc.addEventListener?.("icegatheringstatechange", check);
      // belt & braces: null candidate also signals end-of-candidates
      const prev = pc.onicecandidate;
      pc.onicecandidate = (ev) => {
        prev?.call(pc, ev);
        if (!ev.candidate) done();
      };
    });
  }

  private setState(s: ManualPairState): void {
    this._state = s;
    this.opts.onState?.(s);
  }
}

// ---------- blob codec (base64url JSON: QR- and paste-safe) ----------

export function encodeBlob(msg: Blob1): string {
  return b64urlEncode(JSON.stringify(msg));
}

export function decodeBlob(blob: string): Blob1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(blob.trim()));
  } catch {
    throw new Error("not a valid pairing blob (paste the whole code, nothing else)");
  }
  const m = parsed as Blob1;
  if (m?.v !== 1 || !m.sdp || (m.kind !== "offer" && m.kind !== "answer") || !m.space) {
    throw new Error("unrecognized pairing blob format");
  }
  return m;
}

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 =
    typeof btoa === "function"
      ? btoa(bin)
      : Buffer.from(bytes).toString("base64");
  return b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin =
    typeof atob === "function"
      ? atob(padded)
      : Buffer.from(padded, "base64").toString("binary");
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function randHex(n: number): string {
  const b = new Uint8Array(n / 2);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
