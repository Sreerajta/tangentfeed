/**
 * Signaling server — the only piece of infrastructure in the whole system,
 * kept honest by knowing nothing: it never sees ops, state, or plaintext.
 * It does two jobs: presence (who's in a space's room) and blind relay of
 * signaling blobs (SDP offers/answers, ICE candidates) between peers.
 *
 * Wire (JSON over WebSocket):
 *   client → server:  { t:"join", space, device }
 *                     { t:"signal", to, data }        // data is opaque
 *   server → client:  { t:"peers", devices: [...] }   // reply to join
 *                     { t:"peer-joined", device }
 *                     { t:"peer-left", device }
 *                     { t:"signal", from, data }
 *                     { t:"error", message }
 */

import { WebSocketServer, WebSocket, type RawData } from "ws";

interface Client {
  ws: WebSocket;
  space: string;
  device: string;
}

export interface SignalingServer {
  port: number;
  close(): Promise<void>;
}

export function createSignalingServer(opts: { port?: number } = {}): Promise<SignalingServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: opts.port ?? 0 });
    /** space → device → client */
    const rooms = new Map<string, Map<string, Client>>();

    wss.on("connection", (ws) => {
      let me: Client | null = null;

      ws.on("message", (raw: RawData) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return send(ws, { t: "error", message: "invalid JSON" });
        }

        if (msg["t"] === "join") {
          const space = str(msg["space"]);
          const device = str(msg["device"]);
          if (!space || !device) return send(ws, { t: "error", message: "join needs space and device" });
          if (me) leave(me);
          me = { ws, space, device };
          const room = rooms.get(space) ?? new Map<string, Client>();
          const evicted = room.get(device);
          if (evicted) evicted.ws.close(4000, "replaced by new connection");
          room.set(device, me);
          rooms.set(space, room);
          send(ws, { t: "peers", devices: [...room.keys()].filter((d) => d !== device) });
          for (const c of room.values()) {
            if (c.device !== device) send(c.ws, { t: "peer-joined", device });
          }
          return;
        }

        if (msg["t"] === "signal") {
          if (!me) return send(ws, { t: "error", message: "join first" });
          const to = str(msg["to"]);
          const target = rooms.get(me.space)?.get(to);
          if (!target) return; // peer gone; harmless, WebRTC will retry via presence
          send(target.ws, { t: "signal", from: me.device, data: msg["data"] });
          return;
        }

        send(ws, { t: "error", message: `unknown message type` });
      });

      ws.on("close", () => {
        if (me) leave(me);
        me = null;
      });
    });

    function leave(c: Client): void {
      const room = rooms.get(c.space);
      if (!room || room.get(c.device)?.ws !== c.ws) return;
      room.delete(c.device);
      if (room.size === 0) rooms.delete(c.space);
      for (const other of room?.values() ?? []) {
        send(other.ws, { t: "peer-left", device: c.device });
      }
    }

    wss.on("listening", () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => res());
          }),
      });
    });
    wss.on("error", reject);
  });
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
