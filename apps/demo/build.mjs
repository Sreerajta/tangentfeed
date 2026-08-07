import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";

const SHARED_CSS = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; }
  small, .meta { color: #888; font-size: .8rem; }
  form { display: flex; gap: .5rem; margin: 1rem 0; flex-wrap: wrap; }
  input[type=text] { flex: 1; padding: .5rem; font-size: 1rem; min-width: 10rem; }
  ul { list-style: none; padding: 0; }
  li { display: flex; align-items: center; gap: .6rem; padding: .35rem 0; border-bottom: 1px solid #8883; }
  li span { flex: 1; }
  li span.done { text-decoration: line-through; color: #888; }
  li button { border: none; background: none; color: #c33; font-size: 1.1rem; cursor: pointer; }
  pre { background: #8881; padding: .6rem; border-radius: 6px; font-size: .72rem; overflow-x: auto; }
  details { margin-top: 1.5rem; }
  #error { color: #c33; font-size: .8rem; min-height: 1.2em; }
`;

async function bundle(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: false,
    write: false,
  });
  return result.outputFiles[0].text;
}

function page(title, body, js) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${SHARED_CSS}</style>
</head>
<body>
${body}
<script type="module">
${js}
</script>
</body>
</html>
`;
}

mkdirSync("dist", { recursive: true });

// ---- tabs demo (M3) ----
const tabsBody = `
<h1>tangentfeed <small>M3: live sync between tabs</small></h1>
<p class="meta">device <code id="device"></code> · peers: <b id="peer-count">0</b> <span id="peer-list" style="font-size:.7rem"></span></p>
<p class="meta"><b>Open this page in a second tab.</b> Each tab is a separate replica with its own
IndexedDB database — they share nothing except protocol messages. Edits sync live; reload
either tab and its state persists.</p>
<p id="error"></p>
<form id="add-form"><input type="text" id="new-task" placeholder="Add a task…" autocomplete="off"><button>Add</button></form>
<ul id="tasks"></ul>
<details open>
<summary>Under the hood — <span id="op-count">0</span> ops in the log</summary>
<p class="meta">last 12 ops (· = written here, ← = received):</p>
<pre id="ops"></pre>
<p class="meta">frontier (deviceId → highest HLC seen):</p>
<pre id="frontier"></pre>
</details>
<button id="nuke">wipe this replica &amp; reload</button>
`;
writeFileSync("dist/index.html", page("tangentfeed — tabs demo", tabsBody, await bundle("src/main.ts")));

// ---- webrtc demo (M4) ----
const rtcBody = `
<h1>tangentfeed <small>M4: cross-device sync over WebRTC</small></h1>
<div id="conn-panel">
<p class="meta">1. Run the signaling server: <code>npm start</code> in <code>packages/signaling-server</code> (listens on :8787).<br>
2. Open this page on two devices (for a phone, serve over your laptop's LAN IP and use it in the signaling URL too).<br>
3. Join the same space code on both.</p>
<form id="connect-form">
  <input type="text" id="space-input" placeholder="space code (e.g. kitchen-42)" autocomplete="off">
  <input type="text" id="signaling-input" placeholder="ws://host:8787" autocomplete="off">
  <input type="text" id="passphrase-input" placeholder="passphrase (optional, enables E2E encryption)" autocomplete="off">
  <button>Join</button>
</form>
</div>
<div id="app-panel" style="display:none">
<p class="meta">space <b id="space-label"></b> · device <code id="device"></code> · signaling: <b id="sig-state">connecting</b> · encryption: <b id="enc-state">off</b> · connected peers: <b id="peer-count">0</b> <span id="peer-list" style="font-size:.7rem"></span></p>
<form id="add-form"><input type="text" id="new-task" placeholder="Add a task…" autocomplete="off"><button>Add</button></form>
<ul id="tasks"></ul>
<details open>
<summary>Under the hood — <span id="op-count">0</span> ops in the log</summary>
<p class="meta">last 12 ops (· = written here, ← = received). With a passphrase set, values show as <code>e1:</code> ciphertext — that is exactly what the signaling server and any relay would see:</p>
<pre id="ops"></pre>
<p class="meta">peer connections:</p>
<pre id="diag"></pre>
</details>
</div>
<p id="error"></p>
`;
writeFileSync("dist/webrtc.html", page("tangentfeed — WebRTC demo", rtcBody, await bundle("src/webrtc.ts")));

// ---- manual QR pairing demo (M6) ----
const manualBody = `
<h1>tangentfeed <small>M6: pair with QR codes — no server</small></h1>
<p class="meta">device <code id="device"></code> · state: <b id="pair-state">idle</b></p>
<p id="error"></p>
<video id="scanner" style="display:none;width:100%;border-radius:8px" playsinline muted></video>
<div id="choose-panel">
<p class="meta">Two devices on the same Wi-Fi (works with no internet). One creates the invite, the other joins.</p>
<form onsubmit="return false"><button id="btn-create">Create invite</button><button id="btn-join">I have an invite</button></form>
</div>
<div id="create-panel" style="display:none">
<p class="meta"><b>Step 1.</b> Show this QR to the other device (or copy the code to it):</p>
<canvas id="offer-qr"></canvas>
<textarea id="offer-blob" rows="3" style="width:100%;font-size:.65rem" readonly></textarea>
<button id="btn-copy-offer">Copy code</button>
<p class="meta"><b>Step 2.</b> Paste (or scan) the ANSWER the other device shows you:</p>
<textarea id="answer-blob" rows="3" style="width:100%;font-size:.65rem" placeholder="paste answer code here"></textarea>
<button id="btn-accept-answer">Connect</button> <button id="btn-scan-answer">Scan with camera</button>
</div>
<div id="join-panel" style="display:none">
<p class="meta"><b>Step 1.</b> Paste (or scan) the INVITE from the other device:</p>
<textarea id="offer-input" rows="3" style="width:100%;font-size:.65rem" placeholder="paste invite code here"></textarea>
<button id="btn-accept-offer">Accept invite</button> <button id="btn-scan-offer">Scan with camera</button>
<div id="answer-out" style="display:none">
<p class="meta"><b>Step 2.</b> Show this ANSWER back to the first device:</p>
<canvas id="answer-qr"></canvas>
<textarea id="answer-blob-out" rows="3" style="width:100%;font-size:.65rem" readonly></textarea>
<button id="btn-copy-answer">Copy code</button>
</div>
</div>
<div id="app-panel" style="display:none">
<p class="meta">space <b id="space-label"></b> · paired peer-to-peer, zero infrastructure</p>
<form id="add-form"><input type="text" id="new-task" placeholder="Add a task…" autocomplete="off"><button>Add</button></form>
<ul id="tasks"></ul>
<details open>
<summary>Under the hood</summary>
<p class="meta">last 12 ops (· = written here, ← = received over the paired channel):</p>
<pre id="ops"></pre>
</details>
</div>
`;
writeFileSync("dist/manual.html", page("tangentfeed — QR pairing demo", manualBody, await bundle("src/manual.ts")));

console.log("dist/index.html + dist/webrtc.html + dist/manual.html written");
