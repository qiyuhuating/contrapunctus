# Contributing

Small repo, few rules, all enforced in CI.

## Setup

- Node **≥ 20** (Node 24 is what CI runs).
- `npm install` — dev dependencies only (`typescript`, `vitest`). The core has **zero runtime
  dependencies** and must stay that way.
- Requires `Intl.Segmenter` (any modern browser / Node ≥ 16).

## Commands

| Command | Does |
|---|---|
| `npm run typecheck` | strict TypeScript check, no emit |
| `npm test` | unit + property suites (`src/**/*.test.ts`, `tests/**/*.test.ts`) |
| `npm run fuzz` | full chaos fuzz suites (`tests/**/*.suite.ts`), 100 seeds |
| `npm run bench` | benchmarks (local insert ops/s, remote apply ops/s, sync settle time) |
| `npm run demo` | build + serve the demo at <http://127.0.0.1:5179> (`PORT` env to override) |
| `npm run coverage` | vitest coverage |

## The golden rule

**Never weaken a test to pass.** If a test fails, the implementation is wrong (or the test found a
real contradiction in the design). Fix the code, not the assertion. If you believe the *test* is
wrong, say so in the PR and get agreement before touching it.

Randomized suites are seeded: a failure prints its seed and honors a `SEED` env override
(`SEED=1234 npm run fuzz`). Always report failing seeds in the issue/PR — a seed makes a heisenbug
deterministically reproducible.

## PR expectations

- `npm run typecheck` clean, `npm test` and `npm run fuzz` green, no skipped tests.
- Tests must be **deterministic**: all randomness through `mulberry32` from `src/rng.ts`; no
  `Math.random`, `Date.now`, or wall-clock timing in engine or test logic (the network simulator's
  virtual clock is the only clock).
- New engine code stays inside the existing contract (`src/crdt/types.ts` signatures, `Op` wire
  format): additive changes fine, breaking changes must be called out and justified in the PR.
- Style: ESM, strict TypeScript, no `any`, no unused exports, kebab-case files, tests colocated
  (`*.test.ts` next to source; wave-2 suites under `tests/`).
- One topic per PR; include the failing seed or a demo scenario when fixing a convergence bug.
