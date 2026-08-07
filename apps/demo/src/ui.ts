/** Shared UI for the demos. Nothing tangentfeed-specific beyond the public API. */
import type { SyncedSpace } from "tangentfeed";
import type { RowData } from "@tangentfeed/core";

export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

export function flashError(text: string) {
  const box = document.getElementById("error");
  if (!box) return;
  box.textContent = text;
  setTimeout(() => (box.textContent = ""), 8000);
}

export function mountTaskApp(db: SyncedSpace) {
  const input = el<HTMLInputElement>("new-task");
  const list = el<HTMLUListElement>("tasks");
  const opsPre = document.getElementById("ops");
  const opCount = document.getElementById("op-count");

  async function render() {
    const tasks = await db.list("tasks");
    list.replaceChildren(
      ...tasks.map((t: RowData) => {
        const li = document.createElement("li");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = t["done"] === true;
        cb.onchange = () => db.update("tasks", t.id, { done: cb.checked });
        const span = document.createElement("span");
        span.textContent = String(t["title"] ?? "");
        span.className = cb.checked ? "done" : "";
        const del = document.createElement("button");
        del.textContent = "×";
        del.title = "delete (writes a tombstone op)";
        del.onclick = () => db.delete("tasks", t.id);
        li.append(cb, span, del);
        return li;
      }),
    );

    if (opsPre) {
      const ops = await db.engine.opsSince({});
      if (opCount) opCount.textContent = String(ops.length);
      opsPre.textContent = ops
        .slice(-12)
        .map((o) => {
          const mine = o.device === db.deviceId ? "·" : "←";
          const raw = JSON.stringify(o.value);
          const shown = raw.length > 44 ? raw.slice(0, 44) + '…"' : raw;
          return `${mine} ${o.hlc}  ${o.table}.${o.column} = ${shown}`;
        })
        .join("\n");
    }
  }

  db.subscribe(() => void render());
  el<HTMLFormElement>("add-form").onsubmit = (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    input.value = "";
    void db.insert("tasks", { title, done: false });
  };
  void render();
}
