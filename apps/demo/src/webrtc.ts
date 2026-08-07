/**
 * Cross-device demo — public API only.
 * Run the signaling server, open on two devices, join the same space.
 */
import { openSpace, webrtc, type SyncedSpace } from "tangentfeed";
import { mountTaskApp, el, flashError } from "./ui.js";

let active: SyncedSpace | null = null;

async function connect(space: string, signaling: string, passphrase: string) {
  await active?.close();

  const db = await openSpace({
    space,
    transports: [
      webrtc({
        signaling,
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        onSignalingState: (state) => {
          const label = el("sig-state");
          label.textContent = state;
          label.style.color =
            state === "connected" ? "#2a2" : state === "conflict" ? "#c33" : "#c93";
          if (state === "disconnected") {
            flashError(`signaling server unreachable at ${signaling} — is it running?`);
          }
          if (state === "conflict") flashError("deviceId conflict — press Join again");
        },
      }),
    ],
    ...(passphrase ? { encryption: { passphrase } } : {}),
    onError: (err) => flashError(String(err)),
  });
  active = db;

  el("device").textContent = db.deviceId;
  el("space-label").textContent = space;
  el("enc-state").textContent = passphrase ? "on (XChaCha20-Poly1305)" : "off";
  el("enc-state").style.color = passphrase ? "#2a2" : "#888";
  el("conn-panel").style.display = "none";
  el("app-panel").style.display = "";

  setInterval(() => {
    const peers = db.peers();
    el("peer-count").textContent = String(peers.length);
    el("peer-list").textContent = peers.join(", ") || "waiting for peers…";
  }, 500);

  mountTaskApp(db);
}

el<HTMLFormElement>("connect-form").onsubmit = (e) => {
  e.preventDefault();
  const space = el<HTMLInputElement>("space-input").value.trim() || "demo";
  const url = el<HTMLInputElement>("signaling-input").value.trim();
  const pass = el<HTMLInputElement>("passphrase-input").value;
  void connect(space, url, pass).catch((err) => flashError(String(err)));
};

el<HTMLInputElement>("signaling-input").value = `ws://${location.hostname || "localhost"}:8787`;
