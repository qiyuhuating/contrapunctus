// Full chaos suites. `npm run fuzz` runs these; `npm test` runs the lighter
// colocated unit/mini-fuzz tests instead. Seeded & deterministic — a failure
// prints its seed and honors SEED=<n> to reproduce a single case.
import { describe, expect, it } from "vitest";
import { Cluster, FugueReplica, graphemes } from "../src/index.js";
import type { Op, ReplicaId } from "../src/index.js";
import { mulberry32 } from "../src/rng.js";

const IDS: ReplicaId[] = ["alice", "bob", "carol", "dave"];
const POOL = ["a", "b", "c", "x", " ", "中", "文", "👍🏻", "🇨🇳", "é"];
const keyOf = (id: { replica: string; counter: number }): string => `${id.replica}#${id.counter}`;

describe("chaos fuzz: latency + jitter + dup + reorder", () => {
  const steps = 220;
  const seedCount = Number(process.env.SEED === undefined ? 100 : 1);

  it(`${seedCount} seeded scenarios converge without loss or duplication`, () => {
    const seed0 = process.env.SEED !== undefined ? Number(process.env.SEED) : 0;
    for (let s = seed0; s < seed0 + seedCount; s++) {
      const rng = mulberry32(s);
      const dupRate = s % 2 === 0 ? 0.15 : 0;
      const cluster = new Cluster([...IDS], {
        seed: s * 31 + 7,
        latencyMs: 15,
        jitterMs: 45,
        dupRate,
      });
      const inserted = new Map<string, string>();
      const deleted = new Set<string>();
      cluster.onEvent((e) => {
        if (e.type !== "local-op") return;
        for (const op of e.ops) {
          if (op.kind === "insert") inserted.set(keyOf(op.id), op.char!);
          else deleted.add(keyOf(op.id));
        }
      });

      for (let i = 0; i < steps; i++) {
        const who = IDS[Math.floor(rng() * IDS.length)]!;
        const rep = cluster.replica(who);
        if (rng() < 0.72 || rep.length === 0) {
          const idx = Math.floor(rng() * (rep.length + 1));
          const piece = Array.from(
            { length: 1 + Math.floor(rng() * 3) },
            () => POOL[Math.floor(rng() * POOL.length)]!,
          ).join("");
          cluster.localInsert(who, idx, piece);
        } else {
          const start = Math.floor(rng() * rep.length);
          const len = 1 + Math.floor(rng() * 4);
          cluster.localDelete(who, start, len);
        }
        cluster.step(6);
      }
      cluster.runUntilSettled();

      const texts = Object.values(cluster.texts());
      expect(new Set(texts).size, `seed ${s}: replicas diverged`).toBe(1);
      expect(cluster.converged(), `seed ${s}`).toBe(true);

      const surviving = [...inserted.entries()].filter(([k]) => !deleted.has(k)).map(([, v]) => v);
      const actual = graphemes(cluster.replica(IDS[0]!).getText());
      expect(actual.length, `seed ${s}: visible length vs surviving nodes`).toBe(surviving.length);
      expect([...surviving].sort(), `seed ${s}: char multiset preserved`).toEqual(actual.sort());
    }
  }, 240000);

  it("same seed twice ⇒ identical network stats", () => {
    const run = (): number => {
      const cluster = new Cluster([...IDS], { seed: 99, latencyMs: 10, jitterMs: 60, dupRate: 0.2, dropRate: 0.05 });
      for (let i = 0; i < 120; i++) {
        cluster.localInsert(IDS[i % IDS.length]!, Math.floor(i / 2), "y");
        cluster.step(4);
      }
      cluster.runUntilSettled();
      return cluster.stats().delivered;
    };
    expect(run()).toBe(run());
  });
});

describe("interleaving stress (FugueMax guarantee)", () => {
  // Two replicas concurrently type different words into the SAME gap they have
  // both seen. Whatever the network does, the words must land contiguously.
  const words = ["AAAA", "BBBB"];

  function race(baseLen: number, tail: boolean): string[] {
    const a = new FugueReplica("a1");
    const b = new FugueReplica("b2");
    const base = new FugueReplica("seed").insertAt(0, "0123456789".slice(0, baseLen));
    for (const op of base) {
      a.applyRemote(op);
      b.applyRemote(op);
    }
    const at = tail ? baseLen : Math.floor(baseLen / 2);
    const aOps: Op[] = a.insertAt(at, words[0]!);
    const bOps: Op[] = b.insertAt(at, words[1]!);
    const results: string[] = [];
    for (let seed = 0; seed < 40; seed++) {
      const rng = mulberry32(seed);
      const merge = new FugueReplica("m");
      for (const op of base) merge.applyRemote(op); // both racers saw the base
      for (const op of [...aOps, ...bOps].sort(() => rng() - 0.5)) merge.applyRemote(op);
      results.push(merge.getText());
    }
    return results;
  }

  for (const baseLen of [0, 1, 6, 10]) {
    for (const tail of [false, true]) {
      it(`base ${baseLen} ${tail ? "tail" : "mid"}: no interleaving across 40 merge orders`, () => {
        for (const text of race(baseLen, tail)) {
          const core = tail ? text.slice(baseLen) : text.slice(Math.floor(baseLen / 2), text.length - Math.ceil(baseLen / 2));
          expect(core === "AAAABBBB" || core === "BBBBAAAA", `got "${core}" in "${text}"`).toBe(true);
        }
      });
    }
  }
});
