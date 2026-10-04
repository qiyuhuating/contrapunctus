import { Cluster } from "../src/index.js";
import type { ClusterEvent, ReplicaId, TreeView } from "../src/index.js";

const IDS: ReplicaId[] = ["alice", "bob", "carol"];
const COLORS: Record<ReplicaId, string> = { alice: "#38e1ff", bob: "#ff6bd6", carol: "#ffc94d" };
const SEED = { latencyMs: 60, jitterMs: 30, seed: 42 };

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s: string): string[] => Array.from(segmenter.segment(s), (x) => x.segment);

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let cluster: Cluster | null = null;
let partitioned = false;

/** Wire the viz taps (dots, pulses, pane flash). Must be called once per Cluster —
 * a soft reset builds a fresh cluster with fresh wiring. */
function wireEvents(c: Cluster): void {
  c.onEvent((e: ClusterEvent) => {
    if (e.type === "deliver") {
      spawn(e.from, e.to, COLORS[e.from]!, false);
      pulse(e.to, COLORS[e.to]!, false);
      const pane = $<HTMLDivElement>(`pane-${e.to}`);
      if (document.activeElement !== pane) {
        pane.classList.add("recv");
        window.setTimeout(() => pane.classList.remove("recv"), 420);
      }
    } else if (e.type === "drop") {
      spawn(e.from, e.to, "#ff5d73", true);
      pulse(e.to, "#ff5d73", false);
    } else if (e.type === "local-op" && e.ops.length > 0) {
      pulse(e.replica, COLORS[e.replica]!, true);
    }
  });
}

function boot(): void {
  const c = new Cluster([...IDS], SEED);
  cluster = c;
  wireEvents(c);
  partitioned = false;
  const badge = $("engine-badge");
  badge.textContent = "engine: online";
  badge.className = "badge online";
}

try {
  boot();
} catch (err) {
  const badge = $("engine-badge");
  badge.textContent = `engine: ${err instanceof Error ? err.message : String(err)}`;
  badge.className = "badge offline";
}

const lastText: Record<ReplicaId, string> = { alice: "", bob: "", carol: "" };

// ---------- editable replica panes: keystrokes diffed into CRDT ops ----------

const composing = new Set<ReplicaId>();

function diffAndApply(id: ReplicaId, nextText: string): void {
  if (!cluster) return;
  const prev = lastText[id] ?? "";
  if (nextText === prev) return;
  const a = graphemes(prev);
  const b = graphemes(nextText);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const delLen = a.length - p - s;
  const insertText = b.slice(p, b.length - s).join("");
  if (delLen > 0) cluster.localDelete(id, p, delLen);
  if (insertText.length > 0) cluster.localInsert(id, p, insertText);
  lastText[id] = nextText;
}

for (const id of IDS) {
  const pane = $<HTMLDivElement>(`pane-${id}`);
  pane.addEventListener("compositionstart", () => composing.add(id));
  pane.addEventListener("compositionend", () => {
    composing.delete(id);
    diffAndApply(id, pane.textContent ?? "");
  });
  pane.addEventListener("input", () => {
    if (composing.has(id)) return; // IME: wait for compositionend
    diffAndApply(id, pane.textContent ?? "");
  });
}

function renderPanes(): void {
  if (!cluster) return;
  for (const id of IDS) {
    const rep = cluster.replica(id);
    const text = rep.getText();
    const pane = $<HTMLDivElement>(`pane-${id}`);
    const focused = document.activeElement === pane;
    if (!focused && lastText[id] !== text) {
      lastText[id] = text;
      pane.textContent = text;
    }
    pane.classList.toggle("empty", text.length === 0);
    const vv = rep.versionVector();
    $(`vv-${id}`).textContent = Object.entries(vv)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}·${v}`)
      .join(" ");
  }
}

// ---------- op flow canvas: DPR-aware, trails, node pulses, drop bursts ----------

const canvas = $<HTMLCanvasElement>("flow");
const ctx = canvas.getContext("2d")!;
const LOGICAL_H = 280;
let W = 900;
let NODE: Record<ReplicaId, [number, number]> = { alice: [170, 200], bob: [450, 60], carol: [730, 200] };

function layoutCanvas(): void {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  W = canvas.clientWidth || 900;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(LOGICAL_H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pad = 90;
  NODE = {
    alice: [pad, LOGICAL_H * 0.74],
    bob: [W / 2, LOGICAL_H * 0.24],
    carol: [W - pad, LOGICAL_H * 0.74],
  };
}
window.addEventListener("resize", layoutCanvas);
layoutCanvas();

type Dot = { from: ReplicaId; to: ReplicaId; t: number; speed: number; color: string; drop: boolean; trail: [number, number][] };
type Pulse = { node: ReplicaId; r: number; alpha: number; color: string };
const dots: Dot[] = [];
const pulses: Pulse[] = [];

function spawn(from: ReplicaId, to: ReplicaId, color: string, drop: boolean): void {
  if (dots.length > 320) dots.shift();
  dots.push({ from, to, t: 0, speed: 0.5 + Math.random() * 0.45, color, drop, trail: [] });
}
function pulse(node: ReplicaId, color: string, big = false): void {
  if (pulses.length > 24) pulses.shift();
  pulses.push({ node, r: big ? 12 : 6, alpha: 0.75, color });
}

function edge(a: [number, number], b: [number, number]): { x0: number; y0: number; cx: number; cy: number; x1: number; y1: number } {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const nx = -(b[1] - a[1]);
  const ny = b[0] - a[0];
  const len = Math.hypot(nx, ny) || 1;
  const bend = 46;
  return { x0: a[0], y0: a[1], cx: mx + (nx / len) * bend, cy: my + (ny / len) * bend, x1: b[0], y1: b[1] };
}

function pointOn(e: ReturnType<typeof edge>, t: number): [number, number] {
  const u = 1 - t;
  return [u * u * e.x0 + 2 * u * t * e.cx + t * t * e.x1, u * u * e.y0 + 2 * u * t * e.cy + t * t * e.y1];
}

function drawFlow(dt: number): void {
  ctx.clearRect(0, 0, W, LOGICAL_H);

  // arcs
  for (const from of IDS) {
    for (const to of IDS) {
      if (from === to) continue;
      const e = edge(NODE[from]!, NODE[to]!);
      const g = ctx.createLinearGradient(e.x0, e.y0, e.x1, e.y1);
      g.addColorStop(0, `${COLORS[from]!}14`);
      g.addColorStop(1, `${COLORS[to]!}0e`);
      ctx.strokeStyle = g;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(e.x0, e.y0);
      ctx.quadraticCurveTo(e.cx, e.cy, e.x1, e.y1);
      ctx.stroke();
    }
  }

  // node pulses (expanding rings)
  ctx.globalCompositeOperation = "lighter";
  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i]!;
    p.r += dt * 0.055;
    p.alpha -= dt * 0.0022;
    if (p.alpha <= 0) {
      pulses.splice(i, 1);
      continue;
    }
    const [x, y] = NODE[p.node]!;
    ctx.strokeStyle = p.color;
    ctx.globalAlpha = p.alpha;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x, y, p.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // dots with comet trails
  for (let i = dots.length - 1; i >= 0; i--) {
    const d = dots[i]!;
    if (!reducedMotion) d.t += (dt / 1000) * d.speed * (d.drop ? 2 : 1);
    if (d.t >= 1) {
      if (d.drop) pulse(d.to, "#ff5d73", false);
      dots.splice(i, 1);
      continue;
    }
    const e = edge(NODE[d.from]!, NODE[d.to]!);
    const [x, y] = pointOn(e, d.t);
    (d.trail as [number, number][]).push([x, y]);
    if (d.trail.length > 7) d.trail.shift();
    const alpha = d.drop ? Math.max(0, 1 - d.t * 2.1) : 0.3 + 0.7 * Math.sin(Math.PI * Math.min(1, d.t * 1.15));
    for (let k = 0; k < d.trail.length; k++) {
      const [tx, ty] = d.trail[k]!;
      const f = (k + 1) / d.trail.length;
      ctx.globalAlpha = alpha * f * 0.35;
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(tx, ty, (d.drop ? 3 : 4) * f, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = d.color;
    ctx.shadowColor = d.color;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(x, y, d.drop ? 3.4 : 4.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  // nodes
  for (const id of IDS) {
    const [x, y] = NODE[id]!;
    const c = COLORS[id]!;
    const halo = ctx.createRadialGradient(x, y, 8, x, y, 46);
    halo.addColorStop(0, `${c}22`);
    halo.addColorStop(1, `${c}00`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, 46, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#060a13";
    ctx.strokeStyle = c;
    ctx.lineWidth = 1.8;
    ctx.shadowColor = c;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(x, y, 21, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = c;
    ctx.font = "600 12.5px ui-monospace, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(id, x, y);
  }
}

// ---------- convergence meter, chips, clock, stats ----------

let lastMeter = 0;
function renderMeter(now: number): void {
  const c = cluster;
  if (!c || now - lastMeter < 140) return;
  lastMeter = now;
  const meter = $("meter");
  const ok = c.converged();
  meter.className = ok ? "meter ok" : "meter syncing";
  $("meter-text").textContent = ok ? "CONVERGED" : "SYNCING";
  $("meter-detail").textContent = ok
    ? `in-flight ${c.inFlight()}`
    : `pending ${IDS.map((id) => `${id}:${c.replica(id).pendingCount()}`).join(" ")} · in-flight ${c.inFlight()}`;

  // per-replica chips: lit when this replica matches the reference text
  const refText = c.replica(IDS[0]!).getText();
  const chips = $("replica-chips");
  if (chips.childElementCount !== IDS.length) {
    chips.innerHTML = "";
    for (const id of IDS) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.id = `chip-${id}`;
      chip.style.setProperty("--accent", COLORS[id]!);
      chip.innerHTML = `<span class="rdot-small"></span>${id}`;
      chips.appendChild(chip);
    }
  }
  for (const id of IDS) {
    const rep = c.replica(id);
    $(`chip-${id}`).className = `chip${!rep.hasPending() && rep.getText() === refText ? " done" : ""}`;
  }

  const st = c.stats();
  $("clock").textContent = `t = ${c.now().toFixed(0)}ms · sent ${st.sent} · delivered ${st.delivered} · dropped ${st.dropped} · dup ${st.duplicated}`;
  $("link-state").textContent = partitioned ? "link state: PARTITIONED alice+bob | carol" : "link state: fully connected";
  $("link-state").style.color = partitioned ? "var(--danger)" : "";
}

// ---------- fugue tree view with connector glyphs ----------

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let lastTreeRender = 0;
let lastTreeHTML = "";
function renderTree(now: number): void {
  if (!cluster || now - lastTreeRender < 320) return;
  lastTreeRender = now;
  const who = $<HTMLSelectElement>("tree-replica").value as ReplicaId;
  let root: TreeView;
  try {
    root = cluster.replica(who).snapshotTree();
  } catch {
    $("tree").innerHTML = `<span class="dim">core loading…</span>`;
    return;
  }
  const out: string[] = [];
  let nodes = 0;
  let visible = 0;
  const walk = (n: TreeView, prefix: string, isRoot: boolean, isLast: boolean, depth: number): void => {
    if (!isRoot) {
      nodes++;
      if (!n.deleted) visible++;
      const glyph = isRoot ? "" : prefix + (isLast ? "└─ " : "├─ ");
      const label = n.char === "\u0000" ? "␀" : esc(n.char);
      out.push(
        `<div class="tnode${n.deleted ? " tomb" : ""}" style="padding-left:${depth * 4}px" data-info="${esc(n.id)} = &quot;${label}&quot;${n.deleted ? " (tombstone)" : ""}"><span class="glyph">${glyph}</span><span class="ch">${label}</span><span class="tid">${esc(n.id)}</span></div>`,
      );
    }
    const kids = n.children;
    const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
    for (let i = 0; i < kids.length; i++) walk(kids[i]!, childPrefix, false, i === kids.length - 1, isRoot ? 0 : depth + 1);
  };
  walk(root, "", true, true, 0);
  const html = out.join("");
  if (html !== lastTreeHTML) {
    lastTreeHTML = html;
    $("tree").innerHTML = html || `<span class="dim">empty tree — type something</span>`;
  }
  $("tree-meta").textContent = `${who}: ${visible} visible · ${nodes - visible} tombstoned · ${nodes} nodes`;
}

$("tree").addEventListener("click", (ev) => {
  const t = (ev.target as HTMLElement).closest(".tnode");
  if (t) $("tree-hint").textContent = `→ ${t.getAttribute("data-info") ?? ""}`;
});

// ---------- network console ----------

const bindSlider = (id: string, apply: (v: number) => void, fmt: (v: number) => string): void => {
  const el = $<HTMLInputElement>(id);
  const sync = (): void => {
    const v = Number(el.value);
    apply(v);
    $(`${id}-v`).textContent = fmt(v);
    const min = Number(el.min);
    const max = Number(el.max);
    el.style.setProperty("--fill", `${((v - min) / (max - min)) * 100}%`);
  };
  el.addEventListener("input", sync);
  sync();
};
bindSlider("latency", (v) => cluster?.setLatency(v), (v) => `${v}ms`);
bindSlider("jitter", (v) => cluster?.setJitter(v), (v) => `${v}ms`);
bindSlider("drop", (v) => cluster?.setDropRate(v / 100), (v) => `${v}%`);
bindSlider("dup", (v) => cluster?.setDupRate(v / 100), (v) => `${v}%`);
$("reorder").addEventListener("change", () => cluster?.setReorder($<HTMLInputElement>("reorder").checked));
$("partition").addEventListener("click", () => {
  if (!cluster) return;
  cluster.partition(["alice", "bob"], ["carol"]);
  partitioned = true;
});
$("heal").addEventListener("click", () => {
  if (!cluster) return;
  cluster.heal();
  partitioned = false;
});

// ---------- scenarios (soft reset rebuilds the cluster in place) ----------

function lit(btn: HTMLElement): void {
  btn.classList.add("lit");
  window.setTimeout(() => btn.classList.remove("lit"), 550);
}

function guarded(btnId: string, fn: () => void): void {
  $(btnId).addEventListener("click", () => {
    if (!cluster) return;
    lit($(btnId));
    try {
      fn();
    } catch (err) {
      console.warn("scenario failed", err);
    }
  });
}

guarded("sc-race", () => {
  if (!cluster) return;
  const mid = Math.floor(cluster.replica("alice").length / 2);
  cluster.localInsert("alice", mid, "Alice");
  cluster.localInsert("bob", mid, "Bob");
  cluster.localInsert("carol", mid, "Carol");
  cluster.runUntilSettled();
});

guarded("sc-partition", () => {
  if (!cluster) return;
  cluster.partition(["alice", "bob"], ["carol"]);
  partitioned = true;
  cluster.localInsert("alice", 0, "LEFT ");
  cluster.localInsert("carol", 0, "RIGHT ");
  cluster.runUntilSettled();
  cluster.heal();
  partitioned = false;
  cluster.runUntilSettled();
});

guarded("sc-emoji", () => {
  if (!cluster) return;
  const pack = ["👍🏻 ", "🇨🇳 ", "🧑‍🚀 ", "中文 ", "é "];
  for (const id of IDS) {
    for (let i = 0; i < 3; i++) {
      const len = cluster.replica(id).length;
      cluster.localInsert(id, Math.floor(Math.random() * (len + 1)), pack[Math.floor(Math.random() * pack.length)]!);
    }
  }
  cluster.runUntilSettled();
});

$("sc-reset").addEventListener("click", () => {
  try {
    const c = new Cluster([...IDS], SEED); // drop old wiring, start a fresh fugue
    cluster = c;
    wireEvents(c);
  } catch (err) {
    console.warn("reset failed", err);
    return;
  }
  partitioned = false;
  dots.length = 0;
  pulses.length = 0;
  lastTreeHTML = "";
  for (const id of IDS) {
    lastText[id] = "";
    $<HTMLDivElement>(`pane-${id}`).textContent = "";
    $<HTMLDivElement>(`pane-${id}`).classList.remove("recv");
  }
  $("tree-hint").textContent = "tombstones dimmed · click a node to inspect";
});

// ---------- main loop + welcome fugue ----------

let lastFrame = performance.now();
function loop(now: number): void {
  const dt = Math.min(64, now - lastFrame);
  lastFrame = now;
  try {
    cluster?.step(dt);
    drawFlow(dt);
    renderPanes();
    renderMeter(now);
    renderTree(now);
  } catch (err) {
    const badge = $("engine-badge");
    badge.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
    badge.className = "badge offline";
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

window.setTimeout(() => {
  if (!cluster) return;
  try {
    cluster.localInsert("alice", 0, "Voices diverge. ");
    window.setTimeout(() => cluster?.localInsert("bob", 0, "Text converges."), 700);
    window.setTimeout(() => cluster?.localInsert("carol", 0, "♪ "), 1400);
  } catch {
    /* engine offline: panes stay clean */
  }
}, 600);
