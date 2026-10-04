# contrapunctus — Design Contract

All agents implement against THIS document. Public signatures below are fixed;
if you must deviate, report the deviation explicitly in your final message.
**Do not modify files outside your ownership list. Do not run `git`. Do not run `npm install`.**

## 1. What this is

A Fugue-tree CRDT collaborative text engine with a chaos-network simulator and an
interactive browser demo. Several replicas ("voices") edit text concurrently; edits
travel through a simulated lossy/reordered/partitioned network; every replica
converges to the same text. Zero runtime dependencies, TypeScript, ESM, strict.

- Algorithm: **Fugue Max Tree** from "The Art of the Fugue: Minimizing Interleaving
  in Collaborative Text Editing" (Weidner & Kleppmann, 2023).
  Fetch the paper via web search if needed and implement it faithfully.
  If the paper is unreachable, fall back to RGA **and flag it loudly in your report**.
- Key guarantees to uphold and TEST: strong eventual consistency (convergence),
  no interleaving of concurrent insert runs, no character loss/duplication,
  grapheme integrity (emoji ZWJ, CJK survive), tombstone correctness.

## 2. Repo layout & ownership

| Path | Owner | Notes |
|---|---|---|
| `DESIGN.md`, `src/index.ts`, `src/rng.ts`, `scripts/serve.mjs`, configs, `package.json` | orchestrator | do not touch |
| `src/crdt/**` (incl. `types.ts`, all `*.test.ts`) | agent-A (core) | FugueReplica + Op types |
| `src/net/**` (incl. all `*.test.ts`) | agent-B (net) | SimNetwork + Cluster |
| `demo/**` | agent-D (demo) | index.html, main.ts, style.css, visuals |
| `ARCHITECTURE.md`, `ROADMAP.md`, `CONTRIBUTING.md`, `LICENSE`, `.github/workflows/ci.yml` | agent-E (docs) | |
| `tests/**` (fuzz/property suites), `bench/**` | agent-C (wave 2) | after A+B land |

Pre-existing stubs `src/crdt/index.ts`, `src/crdt/types.ts`, `src/net/index.ts`
carry the contract signatures and throw `Error("not implemented")` — agents A/B
replace/extend them freely within their own directories. Stub signatures are the
contract; keep them compatible (additive changes allowed, breaking changes must be reported).

## 3. Fixed types (src/crdt/types.ts — agent A owns, keep compatible)

```ts
export type ReplicaId = string;
export type Side = "L" | "R";
export interface ItemId { replica: ReplicaId; counter: number }   // unique per (replica, counter)
export interface Op {
  kind: "insert" | "delete";
  id: ItemId;                 // insert: node being created; delete: node being tombstoned
  char?: string;              // insert only: exactly one grapheme cluster
  parent?: ItemId;            // insert only: parent node in Fugue tree (root = { replica: "", counter: -1 })
  side?: Side;                // insert only: attachment side under parent
  seq: number;                // per-replica operation sequence number
}
export interface TreeView {
  id: string;                 // human-readable, e.g. "alice#3"
  char: string;               // grapheme; root renders "\u0000"
  deleted: boolean;
  children: TreeView[];       // in document (traversal) order
}
```

## 4. Core API (src/crdt/index.ts — agent A)

```ts
export class FugueReplica {
  constructor(id: ReplicaId)
  insertAt(index: number, text: string): Op[]      // local edit; index in grapheme units; returns ops to broadcast (one per grapheme)
  deleteRange(start: number, length: number): Op[] // local delete; returns delete ops (deduped, only currently-visible ids)
  applyRemote(op: Op): void                        // apply or buffer until causally ready (parent known); must be safe to call in ANY order
  getText(): string
  get length(): number                             // visible graphemes
  versionVector(): Readonly<Record<ReplicaId, number>> // max seq seen per replica (incl. self)
  hasPending(): boolean
  pendingCount(): number
  snapshotTree(): TreeView                         // for viz; synthetic root wraps document
}
```

Rules:
- Insert text is split with `Intl.Segmenter` (grapheme granularity) — one Op per grapheme.
- Concurrent inserts that resolve to the same parent/side must have a deterministic
  total order (tie-break by ItemId: replica id, then counter) — no interleaving.
- Deletion of an unknown id is buffered the same way until the id arrives.
- Applying ops in different orders on two replicas must still converge (CRDT property).
- Expose whatever internals you need for tests, but the public API above is what
  Cluster/tests/demo use.

## 5. Network API (src/net/index.ts — agent B)

```ts
export interface SimNetOptions {
  seed?: number;        // default 1
  latencyMs?: number;   // default 40
  jitterMs?: number;    // default 10 (uniform 0..jitter added to latency)
  dropRate?: number;    // default 0 (0..1)
  dupRate?: number;     // default 0 (0..1) probability of one extra copy
  reorder?: boolean;    // default true (jitter may reorder)
}
export type DeliverFn = (msg: OpMessage, to: ReplicaId) => void;
export interface OpMessage { from: ReplicaId; to: ReplicaId; op: Op }

export class SimNetwork {
  constructor(opts?: SimNetOptions)
  send(msg: Omit<OpMessage, "to"> & { to: ReplicaId }): void  // schedule on virtual clock
  onDeliver(fn: DeliverFn): void
  setLink(from: ReplicaId, to: ReplicaId, up: boolean): void  // partition primitive
  step(ms: number): void       // advance virtual clock, deliver everything due
  runUntilSettled(maxMs?: number): void  // step until no in-flight messages or maxMs (default 60000)
  inFlight(): number
  now(): number
  stats(): { sent: number; delivered: number; dropped: number; duplicated: number }
}

export class Cluster {
  constructor(ids: ReplicaId[], opts?: SimNetOptions)
  replica(id: ReplicaId): FugueReplica
  localInsert(id: ReplicaId, index: number, text: string): void   // edit + broadcast to all peers
  localDelete(id: ReplicaId, index: number, length: number): void
  partition(groupA: ReplicaId[], groupB: ReplicaId[]): void       // down every cross-group link
  heal(): void
  setLatency(ms: number): void; setJitter(ms: number): void
  setDropRate(r: number): void; setDupRate(r: number): void; setReorder(b: boolean): void
  step(ms: number): void; runUntilSettled(maxMs?: number): void
  inFlight(): number; now(): number
  converged(): boolean                 // every replica same visible text AND no pending anywhere
  texts(): Record<ReplicaId, string>
  onEvent(cb: (e: ClusterEvent) => void): void   // tap for demo viz
}
export type ClusterEvent =
  | { type: "local-op"; replica: ReplicaId; ops: Op[] }
  | { type: "deliver"; from: ReplicaId; to: ReplicaId; op: Op; at: number }
  | { type: "drop"; from: ReplicaId; to: ReplicaId; op: Op; at: number }
  | { type: "converged"; at: number };
```

Rules:
- All randomness through `mulberry32` from `src/rng.ts` (pre-written by orchestrator).
  Same seed ⇒ byte-identical delivery schedule. Virtual clock starts at 0.
- `runUntilSettled` must terminate even when drops keep losing messages: treat a
  message as gone once dropped (CRDTs tolerate loss only via later ops' causal
  repair — document this; for convergence tests, default dropRate 0 in suites).
- Broadcast = one SimNetwork message per (op, recipient). applyRemote is called
  on delivery. Cluster wires replicas ↔ network; keep it thin.

## 6. Testing standard (real tests only — no tautologies, no fake asserts)

- Seeded & deterministic: every randomized test prints its seed on failure and
  accepts `SEED` env override. A failing seed must be reproducible exactly.
- Agent A (`src/crdt/*.test.ts`): unit tests for insert/delete/basic ordering;
  out-of-order applyRemote convergence; unknown-parent buffering; grapheme corpus
  ("a👍🏻b", "🇨🇳x", "나는", "e\u0301", CJK); tombstone idempotence; Fugue paper
  adversarial scenarios (paper's interleaving figures) — cite figure numbers in comments.
- Agent B (`src/net/*.test.ts`): causal/delivery timing, jitter reordering, drop/dup
  rates, partition blocking, determinism (two runs same seed → identical stats()),
  runUntilSettled termination.
- Wave-2 agent C adds property/fuzz suites under `tests/` + `bench/`.

## 7. Demo (agent D) — must be striking, single page, zero framework

- `demo/index.html` + `demo/main.ts` + `demo/style.css`. Imports runtime code ONLY via
  `import ... from "../src/index.js"` (relative, from demo/main.ts) and loads assets
  with RELATIVE urls (`./demo/main.js`, `./style.css`) — no leading slashes anywhere,
  so the page works on GitHub Pages under a subpath. Locally: tsc emits dist/src +
  dist/demo; serve.mjs maps /src/ → dist/src/, /demo/ → dist/demo/, / → demo/index.html.
- Dark neon aesthetic (near-black bg, cyan/magenta/amber accents per replica).
  Monospace display font for text panes is fine.
- REQUIRED panels:
  1. Three replica text panes (editable contenteditable divs) wired to
     `cluster.localInsert/localDelete` — typing in one pane flows to others.
  2. Network console: sliders (latency, jitter, drop, dup), reorder toggle,
     "partition A|B" and "heal" buttons, in-flight counter, virtual clock.
  3. Animated op-flow canvas: ops as glowing dots travelling along bezier arcs
     between replica nodes; drops flash red; dups fork. rAF loop, no libs.
  4. Live Fugue tree view (one replica, switchable): render `snapshotTree()`
     recursively; tombstones dimmed; clicking a node highlights its char in text.
  5. Convergence meter: green when `cluster.converged()`, else amber + pending counts.
  6. Scenario buttons: "Concurrent race", "Partition & heal", "Emoji storm" —
     scripted sequences using only the Cluster API above.
- Demo must degrade gracefully: no alerts; all controls wired; no dead buttons.
- Typecheck with `npx tsc --noEmit -p tsconfig.json` must pass (against stubs if needed).

## 8. Style & engineering rules

- ESM only, TypeScript strict, no runtime deps (dev deps for tests/build OK).
- No unused exports/vars; no `any` except `never`-proven cases; comments only for
  non-obvious constraints (paper citations welcome).
- File naming: kebab-case. Tests colocated `*.test.ts` next to source (A/B);
  wave-2 suites under `tests/*.suite.ts`.
- Windows cmd shell quirk: prefix commands with `cd /d "C:\Users\xiaofeng\contrapunctus" && `.
  Node v24, npx available, deps already installed by orchestrator.
- Run tests you own: `npx vitest run <your-test-files>`. Never weaken a test to pass.

## 9. Acceptance criteria (whole project)

1. `npm run typecheck` — clean, strict.
2. `npm test` — all unit + mini-fuzz green.
3. `npm run fuzz` — 100-seed chaos suite green (convergence, no interleaving, no loss).
4. `npm run bench` — produces numbers (local insert ops/s, remote apply ops/s, sync settle time).
5. Zero runtime deps: `package.json.dependencies` absent/empty.
6. `npm run demo` serves the interactive demo; visually verified by orchestrator.
7. CI (`.github/workflows/ci.yml`): typecheck + test + fuzz(short) + build on push/PR; Pages deploy on main.
8. README with benchmark table, architecture diagram, quickstart (orchestrator writes it).

## 10. Agent report format (final message)

- Files created (paths), commands run + results (test counts),
- deviations from this contract (or "none"),
- anything the orchestrator must wire manually.
