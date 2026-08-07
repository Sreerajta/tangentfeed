/**
 * WebRTC transport — device-to-device sync over DataChannels.
 *
 * Same four-member Transport interface as BroadcastChannel; everything below
 * this API line is peer lifecycle:
 *
 *   - Presence via the signaling server (join room → peers / peer-joined).
 *   - Deterministic roles kill offer-glare at the root: for any pair, the
 *     LOWER deviceId is the initiator (creates the DataChannel and offer);
 *     the higher answers. Only one side ever offers, so the classic
 *     both-offer-simultaneously race cannot occur.
 *   - Trickle ICE relayed as opaque blobs through the signaling server.
 *   - Fan-out send: WireMsg JSON to every open channel (bus semantics);
 *     Replicator's `to` filtering discards what isn't addressed to a peer.
 *   - Signaling reconnect with capped exponential backoff; peer connections
 *     are rebuilt on rejoin. Op idempotency upstream makes all of this safe.
 *
 * Environment injection: pass `wrtc` (RTCPeerConnection impl) and
 * `WebSocketImpl` for Node (node-datachannel/polyfill, global WebSocket);
 * browsers need neither.
 */

import type { Transport, WireMsg } from "@tangentfeed/core";

type PeerConnectCb = (peerId?: string) => void;

export type SignalingState = "connecting" | "connected" | "disconnected" | "conflict";

export interface WebRTCTransportOptions {
  space: string;
  deviceId: string;
  /** ws:// or wss:// URL of the signaling server */
  signalingUrl: string;
  /** RTCPeerConnection constructor; defaults to globalThis.RTCPeerConnection */
  wrtc?: { RTCPeerConnection: typeof RTCPeerConnection };
  /** WebSocket constructor; defaults to globalThis.WebSocket */
  WebSocketImpl?: typeof WebSocket;
  rtcConfig?: RTCConfiguration;
  /** called on non-fatal internal errors (a peer failing, signaling drop) */
  onError?: (err: unknown, ctx: { peer?: string }) => void;
  /**
   * Signaling connection lifecycle. "conflict" is terminal: another
   * connection claimed this deviceId (the server evicted us). We do NOT
   * auto-reconnect on conflict — doing so would make the two holders evict
   * each other in an endless loop. Recover by reconnecting with a new id.
   */
  onSignalingState?: (state: SignalingState) => void;
}

const CHANNEL_LABEL = "tangentfeed";
const MAX_BACKOFF_MS = 15_000;

interface Peer {
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  /** ICE candidates arriving before the remote description is set */
  pendingCandidates: RTCIceCandidateInit[];
  remoteDescSet: boolean;
}

export class WebRTCTransport implements Transport {
  private readonly opts: WebRTCTransportOptions;
  private readonly RTCPC: typeof RTCPeerConnection;
  private readonly WS: typeof WebSocket;
  private ws: WebSocket | null = null;
  private readonly peers = new Map<string, Peer>();
  private readonly msgListeners = new Set<(msg: WireMsg) => void>();
  private readonly peerConnectListeners = new Set<PeerConnectCb>();
  private closed = false;
  private backoff = 500;

  constructor(opts: WebRTCTransportOptions) {
    this.opts = opts;
    const rtc = opts.wrtc?.RTCPeerConnection ?? globalThis.RTCPeerConnection;
    const ws = opts.WebSocketImpl ?? globalThis.WebSocket;
    if (!rtc) throw new Error("no RTCPeerConnection available; pass opts.wrtc");
    if (!ws) throw new Error("no WebSocket available; pass opts.WebSocketImpl");
    this.RTCPC = rtc;
    this.WS = ws;
    this.connectSignaling();
  }

  // ---------- Transport interface ----------

  send(msg: WireMsg): void {
    const payload = JSON.stringify(msg);
    for (const peer of this.peers.values()) {
      if (peer.channel?.readyState === "open") {
        try {
          peer.channel.send(payload);
        } catch (err) {
          this.opts.onError?.(err, {});
        }
      }
    }
  }

  onMessage(cb: (msg: WireMsg) => void): () => void {
    this.msgListeners.add(cb);
    return () => this.msgListeners.delete(cb);
  }

  onPeerConnect(cb: PeerConnectCb): () => void {
    this.peerConnectListeners.add(cb);
    return () => this.peerConnectListeners.delete(cb);
  }

  close(): void {
    this.closed = true;
    for (const [id] of this.peers) this.dropPeer(id);
    this.ws?.close();
    this.ws = null;
    this.msgListeners.clear();
    this.peerConnectListeners.clear();
  }

  /** Currently connected (channel-open) peer deviceIds. For UI. */
  get connectedPeers(): string[] {
    return [...this.peers.entries()]
      .filter(([, p]) => p.channel?.readyState === "open")
      .map(([id]) => id);
  }

  /** Per-peer diagnostics for debugging/UI: connection + ICE + channel state. */
  get peerDiagnostics(): { id: string; connection: string; ice: string; channel: string }[] {
    return [...this.peers.entries()].map(([id, p]) => ({
      id,
      connection: p.pc.connectionState ?? "?",
      ice: p.pc.iceConnectionState ?? "?",
      channel: p.channel?.readyState ?? "no channel",
    }));
  }

  // ---------- signaling ----------

  private connectSignaling(): void {
    if (this.closed) return;
    this.opts.onSignalingState?.("connecting");
    const ws = new this.WS(this.opts.signalingUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 500;
      this.opts.onSignalingState?.("connected");
      this.sigSend({ t: "join", space: this.opts.space, device: this.opts.deviceId });
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      void this.handleSignaling(msg).catch((err) =>
        this.opts.onError?.(err, {}),
      );
    };

    ws.onclose = (ev: CloseEvent) => {
      if (this.closed) return;
      // 4000 = the server evicted us: another connection joined with OUR
      // deviceId. Retrying would evict them back — an infinite duel (the
      // classic cause: browser tab duplication copying sessionStorage).
      // Terminal; the app must rejoin with a fresh deviceId.
      if (ev.code === 4000) {
        this.opts.onSignalingState?.("conflict");
        this.opts.onError?.(
          new Error("deviceId already connected to this space (evicted); rejoin with a new deviceId"),
          {},
        );
        return;
      }
      this.opts.onSignalingState?.("disconnected");
      // peers may survive a signaling blip (media path is independent), but
      // rebuilding on rejoin is simpler and always correct; drop and retry.
      setTimeout(() => this.connectSignaling(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };
    ws.onerror = () => {
      /* onclose handles retry */
    };
  }

  private sigSend(msg: unknown): void {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async handleSignaling(msg: Record<string, unknown>): Promise<void> {
    switch (msg["t"]) {
      case "peers": {
        for (const device of (msg["devices"] as string[]) ?? []) {
          void this.ensurePeer(device);
        }
        break;
      }
      case "peer-joined": {
        void this.ensurePeer(msg["device"] as string);
        break;
      }
      case "peer-left": {
        this.dropPeer(msg["device"] as string);
        break;
      }
      case "signal": {
        await this.handleSignal(msg["from"] as string, msg["data"] as SignalData);
        break;
      }
    }
  }

  // ---------- peer lifecycle ----------

  private isInitiatorFor(peerId: string): boolean {
    return this.opts.deviceId < peerId; // lower deviceId offers; total order, no glare
  }

  private async ensurePeer(peerId: string): Promise<void> {
    if (!peerId || peerId === this.opts.deviceId || this.peers.has(peerId)) return;
    const pc = new this.RTCPC(this.opts.rtcConfig ?? {});
    const peer: Peer = { pc, pendingCandidates: [], remoteDescSet: false };
    this.peers.set(peerId, peer);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.sigSend({ t: "signal", to: peerId, data: { kind: "ice", candidate: ev.candidate } });
      }
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        this.dropPeer(peerId);
      }
    };

    if (this.isInitiatorFor(peerId)) {
      this.attachChannel(peerId, pc.createDataChannel(CHANNEL_LABEL));
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.sigSend({ t: "signal", to: peerId, data: { kind: "sdp", description: pc.localDescription } });
      } catch (err) {
        this.opts.onError?.(err, { peer: peerId });
        this.dropPeer(peerId);
      }
    } else {
      pc.ondatachannel = (ev) => this.attachChannel(peerId, ev.channel);
    }
  }

  private async handleSignal(from: string, data: SignalData): Promise<void> {
    await this.ensurePeer(from);
    const peer = this.peers.get(from);
    if (!peer) return;

    try {
      if (data.kind === "sdp" && data.description) {
        await peer.pc.setRemoteDescription(data.description);
        peer.remoteDescSet = true;
        for (const c of peer.pendingCandidates.splice(0)) {
          await peer.pc.addIceCandidate(c);
        }
        if (data.description.type === "offer") {
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          this.sigSend({ t: "signal", to: from, data: { kind: "sdp", description: peer.pc.localDescription } });
        }
      } else if (data.kind === "ice" && data.candidate) {
        if (peer.remoteDescSet) await peer.pc.addIceCandidate(data.candidate);
        else peer.pendingCandidates.push(data.candidate);
      }
    } catch (err) {
      this.opts.onError?.(err, { peer: from });
    }
  }

  private attachChannel(peerId: string, channel: RTCDataChannel): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.channel = channel;
    channel.onopen = () => {
      for (const cb of this.peerConnectListeners) cb(peerId);
    };
    channel.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WireMsg;
        for (const cb of this.msgListeners) cb(msg);
      } catch (err) {
        this.opts.onError?.(err, { peer: peerId });
      }
    };
    channel.onclose = () => {
      // connectionstatechange usually fires too; dropPeer is idempotent
      if (this.peers.get(peerId)?.channel === channel) this.dropPeer(peerId);
    };
  }

  private dropPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    try {
      peer.channel?.close();
    } catch {
      /* already closed */
    }
    try {
      peer.pc.close();
    } catch {
      /* already closed */
    }
  }
}

interface SignalData {
  kind: "sdp" | "ice";
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export {
  ManualPairTransport,
  encodeBlob,
  decodeBlob,
  type ManualPairState,
  type ManualPairOptions,
} from "./manual.js";
