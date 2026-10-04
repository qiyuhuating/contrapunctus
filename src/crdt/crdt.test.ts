import { describe, expect, it } from "vitest";
import { FugueReplica, graphemes } from "./index.js";
import type { Op, ReplicaId } from "./types.js";
import { mulberry32 } from "../rng.js";

type Session = { replicas: Map<ReplicaId, FugueReplica>; log: Op[] };

function newSession(ids: ReplicaId[]): Session {
  const replicas = new Map(ids.map((id) => [id, new FugueReplica(id)]));
  return { replicas, log: [] };
}

function edit(s: Session, id: ReplicaId, index: number, text: string): void {
  s.replicas.get(id)!.insertAt(index, text).forEach((op) => s.log.push(op));
}

function del(s: Session, id: ReplicaId, index: number, len: number): void {
  s.replicas.get(id)!.deleteRange(index, len).forEach((op) => s.log.push(op));
}

/** Every replica applies every op currently in the log (catch-up between edits). */
function deliverAll(s: Session): void {
  for (const op of s.log) {
    for (const rep of s.replicas.values()) rep.applyRemote(op);
  }
}

function shuffled<T>(xs: T[], rng: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Replays ops in creation order into fresh replicas — the reference result. */
function replayInOrder(log: Op[], ids: ReplicaId[]): string {
  const reps = new Map(ids.map((id) => [id, new FugueReplica(id)]));
  for (const op of log) {
    reps.get(op.from ?? op.id.replica)!.applyRemote(op);
    for (const [rid, rep] of reps) if (rid !== (op.from ?? op.id.replica)) rep.applyRemote(op);
  }
  const texts = [...reps.values()].map((r) => r.getText());
  expect(new Set(texts).size).toBe(1);
  return texts[0]!;
}

function expectConverged(log: Op[], ids: ReplicaId[], expected: string): void {
  for (let order = 0; order < 50; order++) {
    const rng = mulberry32(order * 7919 + 1);
    const reps = new Map(ids.map((id) => [id, new FugueReplica(id)]));
    for (const op of shuffled(log, rng)) {
      for (const rep of reps.values()) rep.applyRemote(op);
    }
    for (const [rid, rep] of reps) {
      expect(rep.hasPending(), `replica ${rid} pending after settle`).toBe(false);
      expect(rep.getText(), `order ${order} replica ${rid}`).toBe(expected);
    }
  }
}

describe("FugueReplica: local editing", () => {
  it("inserts and deletes on a single replica", () => {
    const r = new FugueReplica("solo");
    expect(r.insertAt(0, "hello")).toHaveLength(5);
    expect(r.getText()).toBe("hello");
    expect(r.insertAt(5, "!")).toHaveLength(1);
    expect(r.getText()).toBe("hello!");
    expect(r.insertAt(2, "XY")).toHaveLength(2);
    expect(r.getText()).toBe("heXYllo!");
    const ops = r.deleteRange(2, 2);
    expect(ops).toHaveLength(2);
    expect(r.getText()).toBe("hello!");
    expect(r.deleteRange(2, 2)).toHaveLength(2); // positions shifted: now deletes "ll"
    expect(r.getText()).toBe("heo!");
    // Re-delivering the same delete ops must be a no-op (idempotent).
    for (const op of ops) r.applyRemote(op);
    expect(r.getText()).toBe("heo!");
  });

  it("clamps out-of-range indices", () => {
    const r = new FugueReplica("solo");
    r.insertAt(0, "ab");
    r.insertAt(999, "Z");
    expect(r.getText()).toBe("abZ");
    r.insertAt(-5, "Q");
    expect(r.getText()).toBe("QabZ");
    expect(r.deleteRange(5, 10)).toHaveLength(0);
  });

  it("empty text inserts nothing", () => {
    const r = new FugueReplica("solo");
    expect(r.insertAt(0, "")).toHaveLength(0);
    expect(r.getText()).toBe("");
  });
});

describe("FugueReplica: causal buffering", () => {
  it("buffers an insert whose parent has not arrived", () => {
    const a = new FugueReplica("a");
    const b = new FugueReplica("b");
    const ops = a.insertAt(0, "hi");
    const [second] = ops.slice(1);
    b.applyRemote(second!); // parent (first op) missing
    expect(b.hasPending()).toBe(true);
    expect(b.getText()).toBe("");
    b.applyRemote(ops[0]!);
    expect(b.hasPending()).toBe(false);
    expect(b.getText()).toBe("hi");
  });

  it("buffers a delete that races ahead of its node", () => {
    const a = new FugueReplica("a");
    const b = new FugueReplica("b");
    const ops = a.insertAt(0, "xy");
    b.applyRemote(ops[1]!); // delete of x before x is known — use insert of y first
    b.applyRemote({ kind: "delete", id: ops[0]!.id, seq: 99, from: "b" });
    expect(b.hasPending()).toBe(true);
    b.applyRemote(ops[0]!);
    expect(b.hasPending()).toBe(false);
    expect(b.getText()).toBe("y");
  });

  it("ignores duplicated insert delivery", () => {
    const a = new FugueReplica("a");
    const b = new FugueReplica("b");
    const ops = a.insertAt(0, "z");
    b.applyRemote(ops[0]!);
    b.applyRemote(ops[0]!); // network duplicated it
    expect(b.getText()).toBe("z");
    expect(b.length).toBe(1);
  });
});

describe("grapheme integrity", () => {
  const cases: Array<[string, number]> = [
    ["a👍🏻b", 3],
    ["🇨🇳x", 2],
    ["한국어", 3],
    ["e\u0301", 1],
    ["中文", 2],
  ];
  for (const [text, len] of cases) {
    it(`counts ${JSON.stringify(text)} as ${len} graphemes`, () => {
      const r = new FugueReplica("solo");
      r.insertAt(0, text);
      expect(r.length).toBe(len);
      expect(r.getText()).toBe(text);
    });
  }

  it("keeps ZWJ sequences intact across edits", () => {
    const r = new FugueReplica("solo");
    r.insertAt(0, "ab👍🏻cd");
    expect(r.length).toBe(5);
    r.deleteRange(2, 1); // remove the whole 👍🏻 cluster only
    expect(r.getText()).toBe("abcd");
    r.insertAt(1, "中文");
    expect(r.getText()).toBe("a中文bcd");
  });
});

describe("no interleaving (paper guarantee)", () => {
  it("concurrent inserts at the same gap stay contiguous", () => {
    const s = newSession(["alice", "bob"]);
    edit(s, "alice", 0, "ab");
    deliverAll(s);
    edit(s, "alice", 1, "Alice");
    edit(s, "bob", 1, "Bob");
    const expected = replayInOrder(s.log, ["alice", "bob"]);
    expect(["aAliceBobb", "aBobAliceb"]).toContain(expected);
    expectConverged(s.log, ["alice", "bob"], expected);
  });

  it("concurrent typing at the document end stays contiguous", () => {
    const s = newSession(["alice", "bob"]);
    edit(s, "alice", 0, "ab");
    deliverAll(s);
    edit(s, "alice", 2, "Alice");
    edit(s, "bob", 2, "Bob");
    const expected = replayInOrder(s.log, ["alice", "bob"]);
    expect(expected.endsWith("BobAlice") || expected.endsWith("AliceBob")).toBe(true);
    expect(expected).toMatch(/ab(AliceBob|BobAlice)$/);
    expectConverged(s.log, ["alice", "bob"], expected);
  });

  it("concurrent typing into an empty document stays contiguous", () => {
    const s = newSession(["alice", "bob", "carol"]);
    edit(s, "alice", 0, "Alice");
    edit(s, "bob", 0, "Bob");
    edit(s, "carol", 0, "Carol");
    const expected = replayInOrder(s.log, ["alice", "bob", "carol"]);
    expect(expected).toMatch(/^(AliceBobCarol|AliceCarolBob|BobAliceCarol|BobCarolAlice|CarolAliceBob|CarolBobAlice)$/);
    expectConverged(s.log, ["alice", "bob", "carol"], expected);
  });
});

describe("out-of-order convergence", () => {
  const scenarios: Array<[string, (s: Session) => void]> = [
    ["greeting", (s) => {
      edit(s, "a", 0, "Hello");
      edit(s, "b", 5, "World");
      edit(s, "c", 10, "!");
    }],
    ["same-gap race", (s) => {
      edit(s, "a", 0, "ab");
      edit(s, "a", 1, "X");
      edit(s, "b", 1, "Y");
      edit(s, "c", 1, "Z");
    }],
    ["delete around insert", (s) => {
      edit(s, "a", 0, "abcdef");
      edit(s, "b", 2, "XY");
      del(s, "c", 1, 4); // deletes bcde, X,Y survive
    }],
    ["mutual deletes", (s) => {
      edit(s, "a", 0, "one");
      edit(s, "b", 3, "two");
      del(s, "a", 0, 3);
      del(s, "b", 0, 3);
    }],
    ["wipe and retype", (s) => {
      edit(s, "a", 0, "hello world");
      del(s, "b", 0, 11);
      edit(s, "c", 0, "again");
    }],
    ["head vs tail", (s) => {
      edit(s, "a", 0, "mid");
      edit(s, "b", 0, "L");
      edit(s, "c", 4, "R");
    }],
    ["insert inside word being typed", (s) => {
      edit(s, "a", 0, "fugue");
      edit(s, "b", 2, "XX");
      edit(s, "a", 5, "tree");
      edit(s, "c", 1, "-");
    }],
    ["emoji storm", (s) => {
      edit(s, "a", 0, "🇨🇳");
      edit(s, "b", 2, "👍🏻");
      edit(s, "c", 1, "한");
      edit(s, "a", 1, "e\u0301");
    }],
    ["delete then reinsert same spot", (s) => {
      edit(s, "a", 0, "keep");
      del(s, "b", 1, 2);
      edit(s, "c", 1, "EE");
      edit(s, "a", 2, "ff");
    }],
    ["long chain with remote splices", (s) => {
      edit(s, "a", 0, "0123456789");
      edit(s, "b", 5, "abc");
      edit(s, "c", 0, ">>>");
      del(s, "a", 3, 2);
      edit(s, "b", 12, "<");
    }],
  ];

  for (const [name, script] of scenarios) {
    it(`converges for scenario: ${name}`, () => {
      const s = newSession(["a", "b", "c"]);
      script(s);
      const expected = replayInOrder(s.log, ["a", "b", "c"]);
      expectConverged(s.log, ["a", "b", "c"], expected);
    });
  }
});

describe("seeded mini-fuzz", () => {
  const POOL = ["a", "b", "c", "中", "👍🏻", "🇨🇳", "é"];

  it("30 seeds: random concurrent edits converge without loss", () => {
    for (let seed = 0; seed < 30; seed++) {
      const rng = mulberry32(seed);
      const ids: ReplicaId[] = ["a", "b", "c"];
      const s = newSession(ids);
      const inserted = new Map<string, string>(); // idKey -> char
      const deleted = new Set<string>();
      const keyOf = (id: { replica: string; counter: number }) => `${id.replica}#${id.counter}`;

      const steps = 120;
      for (let step = 0; step < steps; step++) {
        const who = ids[Math.floor(rng() * ids.length)]!;
        const rep = s.replicas.get(who)!;
        if (rng() < 0.7 || rep.length === 0) {
          const idx = Math.floor(rng() * (rep.length + 1));
          const piece = POOL[Math.floor(rng() * POOL.length)]!;
          for (const op of rep.insertAt(idx, piece)) {
            s.log.push(op);
            if (op.kind === "insert") inserted.set(keyOf(op.id), op.char!);
          }
        } else {
          const start = Math.floor(rng() * rep.length);
          const len = 1 + Math.floor(rng() * 3);
          for (const op of rep.deleteRange(start, len)) {
            s.log.push(op);
            deleted.add(keyOf(op.id));
          }
        }
        // Messy delivery is simulated at settle time below (random per-replica order).
      }

      // Settle: every replica receives every op exactly once, in a random order.
      const rng2 = mulberry32(seed + 1000);
      for (const rep of s.replicas.values()) {
        for (const op of shuffled(s.log, rng2)) rep.applyRemote(op);
      }

      const texts = [...s.replicas.values()].map((r) => r.getText());
      expect(new Set(texts).size, `seed ${seed}`).toBe(1);
      for (const rep of s.replicas.values()) expect(rep.hasPending()).toBe(false);

      const surviving = [...inserted.entries()].filter(([k]) => !deleted.has(k)).map(([, v]) => v);
      const actual = graphemes(texts[0]!);
      expect(actual.length, `seed ${seed}`).toBe(surviving.length);
      expect([...surviving].sort(), `seed ${seed}`).toEqual([...actual].sort());
    }
  }, 30000);
});
