import { Cluster } from "../src/index.js";
import type { ClusterEvent, ReplicaId, TreeView } from "../src/index.js";

const IDS: ReplicaId[] = ["alice", "bob", "carol"];
const COLORS: Record<ReplicaId, string> = { alice: "#22d3ee", bob: "#f472b6", carol: "#fbbf24" };

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s: string): string[] => Array.from(segmenter.segment(s), (x) => x.segment);

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let cluster: Cluster | null = null;
try {
  cluster = new Cluster([...IDS], { seed: 42, latencyMs: 60, jitterMs: 30 });
  const badge = $("engine-badge");
  badge.textContent = "engine: online";
  badge.className = "badge online";
} catch {
  const badge = $("engine-badge");
  badge.textContent = "engine: offline (stubs)";
  badge.className = "badge offline";
}

const lastText: Record<ReplicaId, string> = { alice: "", bob: "", carol: "" };

// --- editable replica panes: diff keystrokes into CRDT ops ---

for (const id of IDS) {
  const pane = $<HTMLDivElement>(`pane-${id}`);
  pane.addEventListener("input", () => {
    if (!cluster) return;
    const next = pane.textContent ?? "";
    const prev = lastText[id] ?? "";
    if (next === prev) return;
    const a = graphemes(prev);
    const b = graphemes(next);
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const delLen = a.length - p - s;
    const insertText = b.slice(p, b.length - s).join("");
    if (delLen > 0) cluster.localDelete(id, p, delLen);
    if (insertText.length > 0) cluster.localInsert(id, p, insertText);
    lastText[id] = next;
  });
}

function renderPanes(): void {
  if (!cluster) return;
  for (const id of IDS) {
    const text = cluster.replica(id).getText();
    const focused = document.activeElement === $(`pane-${id}`);
    if (!focused && lastText[id] !== text) {
      lastText[id] = text;
      $<HTMLDivElement>(`pane-${id}`).textContent = text;
    }
    const vv = cluster.replica(id).versionVector();
    $(`vv-${id}`).textContent = Object.entries(vv)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}·${v}`)
      .join(" ");
  }
}

// --- op flow canvas: dots on bezier arcs between replicas ---

const canvas = $<HTMLCanvasElement>("flow");
const ctx = canvas.getContext("2d")!;

const NODE: Record<ReplicaId, [number, number]> = { alice: [170, 200], bob: [450, 60], carol: [730, 200] };
type Dot = { from: ReplicaId; to: ReplicaId; t: number; speed: number; color: string; drop: boolean };
const dots: Dot[] = [];

function spawn(from: ReplicaId, to: ReplicaId, color: string, drop: boolean): void {
  if (dots.length > 400) dots.shift();
  dots.push({ from, to, t: 0, speed: 0.55 + Math.random() * 0.5, color, drop });
}

if (cluster) {
  cluster.onEvent((e: ClusterEvent) => {
    if (e.type === "deliver") spawn(e.from, e.to, COLORS[e.from]!, false);
    if (e.type === "drop") spawn(e.from, e.to, "#ef4444", true);
  });
}

function edge(a: [number, number], b: [number, number]): { x0: number; y0: number; cx: number; cy: number; x1: number; y1: number } {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const nx = -(b[1] - a[1]);
  const ny = b[0] - a[0];
  const len = Math.hypot(nx, ny) || 1;
  const bend = 42;
  return { x0: a[0], y0: a[1], cx: mx + (nx / len) * bend, cy: my + (ny / len) * bend, x1: b[0], y1: b[1] };
}

function pointOn(e: ReturnType<typeof edge>, t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * e.x0 + 2 * u * t * e.cx + t * t * e.x1,
    u * u * e.y0 + 2 * u * t * e.cy + t * t * e.y1,
  ];
}

function drawFlow(dt: number): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const from of IDS) {
    for (const to of IDS) {
      if (from === to) continue;
      const e = edge(NODE[from]!, NODE[to]!);
      ctx.strokeStyle = "rgba(80, 110, 160, 0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(e.x0, e.y0);
      ctx.quadraticCurveTo(e.cx, e.cy, e.x1, e.y1);
      ctx.stroke();
    }
  }
  for (let i = dots.length - 1; i >= 0; i--) {
    const d = dots[i]!;
    d.t += (dt / 1000) * d.speed * (d.drop ? 2 : 1);
    if (d.t >= 1) {
      dots.splice(i, 1);
      continue;
    }
    const e = edge(NODE[d.from]!, NODE[d.to]!);
    const [x, y] = pointOn(e, d.t);
    const alpha = d.drop ? Math.max(0, 1 - d.t * 2.2) : 0.25 + 0.75 * Math.sin(Math.PI * Math.min(1, d.t * 1.2));
    ctx.globalAlpha = alpha;
    ctx.fillStyle = d.color;
    ctx.shadowColor = d.color;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(x, y, d.drop ? 3.5 : 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }
  for (const id of IDS) {
    const [x, y] = NODE[id]!;
    ctx.fillStyle = "#0a0f1a";
    ctx.strokeStyle = COLORS[id]!;
    ctx.lineWidth = 2;
    ctx.shadowColor = COLORS[id]!;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS[id]!;
    ctx.font = "13px ui-monospace, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(id, x, y);
  }
}

// --- convergence meter, clock, stats ---

let lastMeter = 0;
function renderMeter(now: number): void {
  if (!cluster || now - lastMeter < 150) return;
  lastMeter = now;
  const meter = $("meter");
  if (cluster.converged()) {
    meter.textContent = "CONVERGED";
    meter.className = "meter ok";
    $("meter-detail").textContent = `in-flight ${cluster.inFlight()}`;
  } else {
    meter.textContent = "SYNCING";
    meter.className = "meter syncing";
    const pend = IDS.map((id) => `${id}:${cluster.replica(id).pendingCount()}`).join(" ");
    $("meter-detail").textContent = `pending ${pend} · in-flight ${cluster.inFlight()}`;
  }
  const st = cluster.stats();
  $("clock").textContent = `t = ${cluster.now().toFixed(0)}ms · sent ${st.sent} · delivered ${st.delivered} · dropped ${st.dropped} · dup ${st.duplicated}`;
  $("stats").textContent = `link state: ${partitioned ? "PARTITIONED alice+bob | carol" : "fully connected"}`;
}

// --- fugue tree view ---

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let lastTreeRender = 0;
function renderTree(now: number): void {
  if (!cluster || now - lastTreeRender < 350) return;
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
  const walk = (n: TreeView, depth: number): void => {
    if (n.id !== "root") {
      const label = n.char === "\u0000" ? "␀" : esc(n.char);
      out.push(
        `<div class="tnode${n.deleted ? " tomb" : ""}" style="margin-left:${depth * 14}px" data-info="${esc(n.id)} = &quot;${label}&quot;${n.deleted ? " (tombstone)" : ""}">${label} <span class="tid">${esc(n.id)}</span></div>`,
      );
    }
    for (const c of n.children) walk(c, n.id === "root" ? depth : depth + 1);
  };
  walk(root, 0);
  $("tree").innerHTML = out.join("") || `<span class="dim">empty tree — type something</span>`;
}

$("tree").addEventListener("click", (ev) => {
  const t = (ev.target as HTMLElement).closest(".tnode");
  if (t) $("tree-hint").textContent = `→ ${t.getAttribute("data-info") ?? ""}`;
});

// --- network console ---

let partitioned = false;
const bindSlider = (id: string, apply: (v: number) => void, fmt: (v: number) => string): void => {
  const el = $<HTMLInputElement>(id);
  el.addEventListener("input", () => {
    const v = Number(el.value);
    apply(v);
    $(`${id}-v`).textContent = fmt(v);
  });
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

// --- scenarios ---

function guarded(fn: () => void): () => void {
  return () => {
    if (!cluster) return;
    try {
      fn();
    } catch (err) {
      console.warn("scenario failed", err);
    }
  };
}

$("sc-race").addEventListener("click", guarded(() => {
  if (!cluster) return;
  const mid = Math.floor(cluster.replica("alice").length / 2);
  cluster.localInsert("alice", mid, "Alice");
  cluster.localInsert("bob", mid, "Bob");
  cluster.localInsert("carol", mid, "Carol");
  cluster.runUntilSettled();
}));

$("sc-partition").addEventListener("click", guarded(() => {
  if (!cluster) return;
  cluster.partition(["alice", "bob"], ["carol"]);
  partitioned = true;
  cluster.localInsert("alice", 0, "LEFT ");
  cluster.localInsert("carol", 0, "RIGHT ");
  cluster.runUntilSettled();
  cluster.heal();
  partitioned = false;
  cluster.runUntilSettled();
}));

$("sc-emoji").addEventListener("click", guarded(() => {
  if (!cluster) return;
  const pack = ["👍🏻 ", "🇨🇳 ", "🧑‍🚀 ", "中文 ", "é "];
  for (const id of IDS) {
    for (let i = 0; i < 3; i++) {
      const len = cluster.replica(id).length;
      cluster.localInsert(id, Math.floor(Math.random() * (len + 1)), pack[Math.floor(Math.random() * pack.length)]!);
    }
  }
  cluster.runUntilSettled();
}));

$("sc-reset").addEventListener("click", () => location.reload());

// --- main loop + welcome sequence ---

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
    // Surface loop failures instead of dying silently (degrade gracefully).
    const badge = $("engine-badge");
    badge.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
    badge.className = "badge offline";
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

window.setTimeout(
  guarded(() => {
    if (!cluster) return;
    cluster.localInsert("alice", 0, "Voices diverge. ");
    window.setTimeout(guarded(() => cluster?.localInsert("bob", 0, "Text converges.")), 700);
    window.setTimeout(guarded(() => cluster?.localInsert("carol", 0, "♪ ")), 1400);
  }),
  600,
);
