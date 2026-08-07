/**
 * Tabs demo — built on the public `tangentfeed` API, exactly as an app would.
 * Each tab is an independent replica; they share only protocol messages.
 */
import { openSpace, broadcast, type SyncedSpace } from "tangentfeed";
import { mountTaskApp, el } from "./ui.js";

const SPACE = "demo-tabs";

async function main() {
  const db: SyncedSpace = await openSpace({
    space: SPACE,
    transports: [broadcast()],
    onError: (err) => console.error(err),
  });

  el("device").textContent = db.deviceId;
  setInterval(() => {
    const peers = db.peers();
    el("peer-count").textContent = String(peers.length);
    el("peer-list").textContent = peers.join(", ") || "open a second tab";
  }, 500);

  el<HTMLButtonElement>("nuke").onclick = async () => {
    await db.close();
    indexedDB.deleteDatabase(`tangentfeed:${SPACE}:${db.deviceId}`);
    location.reload();
  };

  mountTaskApp(db);
}

void main();
