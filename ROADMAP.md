# Roadmap

Status: ✅ shipped · ⬜ planned. Each version lists concrete acceptance criteria — a version is done
when every criterion has a test or demo demonstrably passing, not before.

## v0.1 — MVP core (current) ✅

The shipped scope, defined by `DESIGN.md` §9:

- Fugue Max Tree replica: grapheme-correct `insertAt`/`deleteRange` (`Intl.Segmenter`, one op per
  grapheme), out-of-order `applyRemote` with causal buffering, tombstone correctness, `snapshotTree`.
- `SimNetwork` chaos simulator: seed, latency, jitter, drop, dup, reorder, partition links, virtual
  clock, `runUntilSettled` termination; `Cluster` wiring with convergence checks and event tap.
- Unit tests + out-of-order convergence + unicode corpus + paper adversarial scenarios;
  100-seed chaos fuzz suite (`npm run fuzz`); deterministic (seeded, `SEED` env override).
- Benchmark harness (`npm run bench`): local insert ops/s, remote apply ops/s, sync settle time.
- Interactive demo: replica panes, network console, op-flow canvas, Fugue tree view, convergence
  meter, scenario buttons.
- Zero runtime dependencies; strict TypeScript; CI (typecheck, test, fuzz, build) + GitHub Pages
  deploy of the demo.

## v0.2 — Rich-text spans ⬜

Per-grapheme formatting as CRDT data, not a separate layer.

- New `format` op kind (additive to the `Op` union — wire-compatible with v0.1 logs).
- Attributes stored as per-grapheme LWW registers keyed by `(ItemId, attributeName)`; last writer
  wins resolved deterministically by the existing ItemId tie-break.
- API: format/unformat a visible range; `TreeView` (or a parallel view) exposes active attributes.
- Demo: bold/italic controls on a selected range.

**Acceptance criteria**

1. Concurrent `format` vs `format` (same attribute) on the same grapheme converges to one winner on
   all replicas, deterministically.
2. Concurrent `format` vs `delete`/`insert` interleavings converge without attribute leakage onto
   neighbouring graphemes; fuzz suite extended to format ops, 100 seeds green.
3. Formatted text survives out-of-order delivery and unknown-parent buffering like any other op.
4. Demo scenario button "Format race" shows concurrent bold/unbold converging.

## v0.3 — Tombstone GC ⬜

Reclaim tombstoned tree nodes the way Yjs garbage-collects, with honest anchor invalidation.

- GC rule: a tombstone is collectable when it has no live descendants and no pending ops reference it
  (checked against the version vector); collected nodes collapse into their parent's subtree.
- Anchor invalidation à la Yjs: anything that referenced a collected id (cursors, future ops arriving
  late) resolves by a documented, deterministic invalidation rule instead of corrupting the tree.
- Opt-in per replica, so tests can run GC on / off.

**Acceptance criteria**

1. With GC enabled, all existing fuzz suites still converge (100 seeds, GC on).
2. An op targeting a GC'd id is handled by the documented invalidation rule — never resurrects text
   or throws; covered by a dedicated test.
3. Bench shows measurable node-count/memory reduction after deleting a large range.
4. Late-joining replica receiving ops that reference pre-GC history converges to the same text.

## v0.4 — Fugue move ⬜

Move support in the Fugue family: relocate a subtree (a character or contiguous run) without
copy-paste delete+insert semantics.

- New `move` op kind (additive), carrying target id, new parent, and side.
- Fugue-style placement so concurrent moves + inserts resolve without duplication, orphaning, or
  cycles (a moved-away region leaves the rest of the tree untouched).

**Acceptance criteria**

1. Single-replica move produces exactly the expected text; no character duplication.
2. Concurrent move vs move of the same run converges to one location, deterministically, on all
   replicas.
3. Concurrent move vs insert-inside-the-moved-run converges without losing either edit.
4. Cycle safety: a history of moves that would form a parent cycle (A under B under A) resolves by a
   documented rule; dedicated adversarial tests.
5. Fuzz suite extended with move ops; 100 seeds green including move-vs-delete races.

## v0.5 — Persistence + P2P demo ⬜

Survive reloads; leave the simulated network for a real transport.

- Persistence: IndexedDB snapshot (tree + version vector) + delta log of ops past the snapshot;
  save on idle, load on boot, then request missing deltas from a peer.
- Transport demo: WebRTC data channels between two browser tabs (manual offer/answer copy-paste
  signaling, keeping zero runtime dependencies — WebRTC is a browser API, not a package).

**Acceptance criteria**

1. Reload a replica: it restores the exact text and can continue editing against a peer that kept
   running, converging via snapshot + missed deltas.
2. Two tabs over WebRTC exchange ops and converge under real latency, with the existing chaos
   simulator reused for offline tests of the same sync protocol.
3. Corrupt/truncated storage is detected (checksum or version marker) and recovers by discarding the
   snapshot, not by loading wrong text.
4. No runtime dependencies added (signaling is manual, transport is browser-native).

## v0.6 — Benchmarks vs naive RGA + interleaving stress corpus ⬜

Numbers, honestly measured — this is where the README benchmark table gets its comparison column.

- A naive RGA implementation on the same `Op` wire format, behind the same replica interface.
- An interleaving stress corpus: the paper's adversarial scenarios plus generated staggered-anchor
  races; each case asserts either full non-interleaving or (where interleaving is provably
  unavoidable) documents the exact outcome for both algorithms.

**Acceptance criteria**

1. README benchmark table compares Fugue Max Tree vs naive RGA on: local insert ops/s, remote apply
   ops/s, sync settle time — with seeds, corpus sizes, and hardware noted.
2. Stress corpus passes for Fugue Max Tree (no avoidable interleaving) and shows exactly which corpus
   cases interleave under naive RGA.
3. All benchmark runs are reproducible (fixed seeds, deterministic workloads).
4. No cherry-picking: the harness, seeds, and corpus are in-repo and re-runnable via `npm run bench`.

## v0.7 — React binding plugin ⬜

First official integration; ships as a separate package so the core stays framework-free.

- `useSyncExternalStore`-based hook over a `FugueReplica` (or a `Cluster` membership), exposing
  text, pending state, and version vector.
- Controlled text component with cursor/selection mapping onto `ItemId` anchors (leveraging v0.3's
  anchor invalidation), degrading gracefully when the replica is briefly non-converged.

**Acceptance criteria**

1. Two React components sharing a cluster stay in sync bidirectionally, including concurrent typing
   at overlapping positions.
2. Cursor survives remote edits ahead of and behind the caret in the common cases; documented
   behavior in the pathological ones.
3. Strict TypeScript, zero runtime dependencies beyond `react` itself; core `src/` remains
   framework-free.
