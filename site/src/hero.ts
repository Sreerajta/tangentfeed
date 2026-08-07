/**
 * The hero demo runs two real replicas in the page. No mock, no video:
 * these are actual SyncEngine instances merging actual operations, which is
 * the only honest way to demonstrate the claim.
 *
 * The transport between them is a loopback that can be switched off, so a
 * visitor can take both replicas offline, make conflicting edits, and watch
 * convergence happen when the wire comes back.
 */

import { SyncEngine, MemoryAdapter, Replicator, type Transport, type WireMsg } from "@tangentfeed/core";

/**
 * Wrapped in a boot function rather than using top-level await, so the same
 * source can be bundled as a classic script for the self-contained build.
 * Browsers block ES modules on file://, and the demo should still run there.
 */
async function boot() {

// ---------- a wire you can cut ----------

class Wire {
  private listeners = new Map<string, Set<(m: WireMsg) => void>>();
  private queue: { from: string; msg: WireMsg }[] = [];
  online = true;
  onTraffic: ((dir: "ab" | "ba") => void) | null = null;

  endpoint(id: string): Transport {
    return {
      send: (msg: WireMsg) => {
        if (!this.online) {
          this.queue.push({ from: id, msg });
          return;
        }
        this.deliver(id, msg);
      },
      onMessage: (cb) => {
        const set = this.listeners.get(id) ?? new Set();
        set.add(cb);
        this.listeners.set(id, set);
        return () => set.delete(cb);
      },
      close: () => this.listeners.delete(id),
    };
  }

  private deliver(from: string, msg: WireMsg) {
    this.onTraffic?.(from === "a" ? "ab" : "ba");
    for (const [id, set] of this.listeners) {
      if (id === from) continue;
      for (const cb of set) cb(msg);
    }
  }

  /** Reconnect and flush everything written while the wire was cut. */
  reconnect() {
    this.online = true;
    const pending = this.queue.splice(0);
    for (const { from, msg } of pending) this.deliver(from, msg);
  }
}

// ---------- setup ----------

const wire = new Wire();

const engines: Record<"a" | "b", SyncEngine> = {
  a: await SyncEngine.open({ deviceId: "a".repeat(16), storage: new MemoryAdapter() }),
  b: await SyncEngine.open({ deviceId: "b".repeat(16), storage: new MemoryAdapter() }),
};

for (const side of ["a", "b"] as const) {
  const replicator = new Replicator({
    engine: engines[side],
    transport: wire.endpoint(side),
    space: "hero",
  });
  await replicator.start();
}

// seed one shared row so the conflict story has something to act on
const seedId = await engines.a.insert("tasks", { title: "Order rice bran oil", done: false });
await new Promise((r) => setTimeout(r, 60));

// ---------- rendering ----------

const $ = <T extends HTMLElement>(sel: string): T => {
  const node = document.querySelector(sel);
  if (!node) throw new Error(`missing ${sel}`);
  return node as T;
};

function pulse(dir: "ab" | "ba") {
  const wireEl = document.querySelector(".wire");
  if (!wireEl) return;
  const dot = document.createElement("span");
  dot.className = `pulse pulse--${dir}`;
  wireEl.appendChild(dot);
  dot.addEventListener("animationend", () => dot.remove());
}
wire.onTraffic = pulse;

async function render(side: "a" | "b") {
  const engine = engines[side];
  const list = $(`#list-${side}`);
  const rows = await engine.list("tasks");

  list.replaceChildren(
    ...rows.map((row) => {
      const li = document.createElement("li");
      li.className = "task";

      const box = document.createElement("button");
      box.className = "task__check" + (row["done"] === true ? " is-done" : "");
      box.setAttribute("role", "checkbox");
      box.setAttribute("aria-checked", String(row["done"] === true));
      box.setAttribute("aria-label", `Mark ${String(row["title"])} done`);
      box.onclick = () => engine.update("tasks", row.id, { done: row["done"] !== true });

      const title = document.createElement("input");
      title.className = "task__title";
      title.value = String(row["title"] ?? "");
      title.setAttribute("aria-label", "Task title");
      title.onchange = () => engine.update("tasks", row.id, { title: title.value });

      li.append(box, title);
      return li;
    }),
  );

  const log = $(`#log-${side}`);
  const ops = await engine.opsSince({});
  log.replaceChildren(
    ...ops.slice(-5).map((op) => {
      const line = document.createElement("div");
      line.className = "op" + (op.device.startsWith(side) ? " op--own" : " op--in");
      line.innerHTML =
        `<span class="op__mark">${op.device.startsWith(side) ? "&#9656;" : "&#9666;"}</span>` +
        `<span class="op__cell">${op.column === "-" ? "row deleted" : op.column}</span>` +
        `<span class="op__val">${escapeHtml(JSON.stringify(op.value))}</span>`;
      return line;
    }),
  );
  $(`#count-${side}`).textContent = String(ops.length);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

for (const side of ["a", "b"] as const) {
  engines[side].subscribe(() => void render(side));
  $(`#add-${side}`).addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>(`#new-${side}`);
    const title = input.value.trim();
    if (!title) return;
    input.value = "";
    void engines[side].insert("tasks", { title, done: false });
  });
}

// ---------- the wire switch ----------

const toggle = $<HTMLButtonElement>("#wire-toggle");
const stage = $(".demo");
const verdict = $("#verdict");
let conflictStaged = false;

async function setWire(online: boolean) {
  if (online) wire.reconnect();
  else wire.online = false;
  stage.classList.toggle("is-severed", !online);
  toggle.textContent = online ? "Cut the connection" : "Reconnect";
  toggle.setAttribute("aria-pressed", String(!online));
  $("#wire-state").textContent = online ? "Connected" : "Disconnected";

  if (!online) {
    if (!conflictStaged) {
      verdict.textContent = "Disconnected. Edits on either side queue until the wire returns.";
      verdict.classList.remove("is-live");
    }
    return;
  }

  // the payoff: report what actually survived the merge
  if (conflictStaged) {
    conflictStaged = false;
    await new Promise((r) => setTimeout(r, 120));
    const [rowA, rowB] = [
      await engines.a.get("tasks", seedId),
      await engines.b.get("tasks", seedId),
    ];
    const agreed = JSON.stringify(rowA) === JSON.stringify(rowB);
    verdict.textContent = agreed
      ? `Both replicas now read "${String(rowA?.["title"])}", done ${rowB?.["done"] === true}. Neither edit was lost.`
      : "Still settling.";
    verdict.classList.add("is-live");
  } else {
    verdict.textContent = "Connected. Operations flow as you type.";
    verdict.classList.remove("is-live");
  }
}

toggle.addEventListener("click", () => void setWire(!wire.online));

// ---------- guided conflict ----------

$<HTMLButtonElement>("#stage-conflict").addEventListener("click", async () => {
  conflictStaged = true;
  await setWire(false);
  await engines.a.update("tasks", seedId, { title: "Order rice bran oil, 20L" });
  await engines.b.update("tasks", seedId, { done: true });
  verdict.textContent =
    "Apart, both replicas edited the same row. A retitled it, B ticked it done. Now reconnect.";
  verdict.classList.add("is-live");
});

void render("a");
void render("b");
}

void boot();
