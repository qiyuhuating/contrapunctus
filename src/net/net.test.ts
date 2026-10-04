import { describe, expect, it } from "vitest";
import type { FugueReplica } from "../crdt/index.js";
import type { Op, ReplicaId } from "../crdt/types.js";
import { Cluster, SimNetwork, type OpMessage } from "./index.js";

// --- fake replicas: the net layer must not depend on the CRDT core ---

interface FakeState {
  id: ReplicaId;
  received: Op[];
  text: string;
  pending: number;
}

function makeFakeFactory(states: Map<ReplicaId, FakeState>) {
  return (id: ReplicaId): FugueReplica => {
    const state: FakeState = { id, received: [], text: "", pending: 0 };
    states.set(id, state);
    // Order-independent fake document: the text is the op set's chars in a
    // canonical (id-sorted) order, so any delivery order converges.
    const chars = new Map<string, string>();
    let counter = 0;
    const applyLocal = (op: Op): void => {
      const k = `${op.id.replica}#${op.id.counter}`;
      if (op.kind === "insert") chars.set(k, op.char ?? "?");
      else chars.delete(k);
      state.text = [...chars.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, c]) => c).join("");
    };
    const fake = {
      insertAt(_index: number, text: string): Op[] {
        return [...text].map((ch) => {
          const newOp: Op = { kind: "insert", id: { replica: id, counter: counter++ }, seq: counter, char: ch };
          applyLocal(newOp);
          return newOp;
        });
      },
      deleteRange(): Op[] {
        return [];
      },
      applyRemote(op: Op): void {
        state.received.push(op);
        applyLocal(op);
      },
      getText(): string {
        return state.text;
      },
      get length(): number {
        return state.text.length;
      },
      hasPending(): boolean {
        return state.pending > 0;
      },
      pendingCount(): number {
        return state.pending;
      },
      versionVector(): Record<string, number> {
        return {};
      },
      snapshotTree(): unknown {
        return { id: "root", char: "\u0000", deleted: false, children: [] };
      },
    };
    return fake as unknown as FugueReplica;
  };
}

function op(i: number, replica = "a"): Op {
  return { kind: "insert", id: { replica, counter: i }, seq: i, char: "x" };
}

function msg(from: string, to: string, i: number): OpMessage {
  return { from, to, op: op(i, from) };
}

// --- SimNetwork ---

describe("SimNetwork: determinism", () => {
  it("same seed produces an identical delivery schedule", () => {
    const run = (): { log: string[]; stats: ReturnType<SimNetwork["stats"]> } => {
      const net = new SimNetwork({ seed: 7, latencyMs: 20, jitterMs: 90, dupRate: 0.3, dropRate: 0.1 });
      const log: string[] = [];
      net.onDeliver((m) => log.push(`${m.from}>${m.to}#${m.op.id.counter}`));
      for (let i = 0; i < 30; i++) net.send(msg("a", i % 2 === 0 ? "b" : "c", i));
      net.runUntilSettled();
      return { log, stats: net.stats() };
    };
    const r1 = run();
    const r2 = run();
    expect(r1.log).toEqual(r2.log);
    expect(r1.stats).toEqual(r2.stats);
  });
});

describe("SimNetwork: chaos knobs", () => {
  it("jitter can reorder delivery; some of these seeds must reorder", () => {
    let sawReorder = false;
    for (let seed = 0; seed < 10 && !sawReorder; seed++) {
      const net = new SimNetwork({ seed, latencyMs: 10, jitterMs: 200 });
      const delivered: number[] = [];
      net.onDeliver((m) => delivered.push(m.op.id.counter));
      for (let i = 0; i < 20; i++) net.send(msg("a", "b", i));
      net.runUntilSettled();
      const sorted = [...delivered].sort((x, y) => x - y);
      if (sorted.length === 20 && delivered.some((v, i) => v !== i)) sawReorder = true;
    }
    expect(sawReorder).toBe(true);
  });

  it("reorder=false enforces per-pair FIFO despite jitter", () => {
    for (let seed = 0; seed < 5; seed++) {
      const net = new SimNetwork({ seed, latencyMs: 10, jitterMs: 200, reorder: false });
      const delivered: number[] = [];
      net.onDeliver((m) => delivered.push(m.op.id.counter));
      for (let i = 0; i < 20; i++) net.send(msg("a", "b", i));
      net.runUntilSettled();
      expect(delivered).toEqual([...Array(20).keys()]);
    }
  });

  it("dropRate=1 loses everything", () => {
    const net = new SimNetwork({ seed: 3, dropRate: 1 });
    net.onDeliver(() => expect.unreachable("nothing should be delivered"));
    for (let i = 0; i < 10; i++) net.send(msg("a", "b", i));
    net.runUntilSettled();
    const s = net.stats();
    expect(s.sent).toBe(10);
    expect(s.delivered).toBe(0);
    expect(s.dropped).toBe(10);
  });

  it("dupRate=1 duplicates every message", () => {
    const net = new SimNetwork({ seed: 3, dupRate: 1, latencyMs: 5, jitterMs: 50 });
    let delivered = 0;
    net.onDeliver(() => delivered++);
    for (let i = 0; i < 10; i++) net.send(msg("a", "b", i));
    net.runUntilSettled();
    const s = net.stats();
    expect(s.duplicated).toBe(10);
    expect(delivered).toBe(20);
  });

  it("runUntilSettled drains the queue and terminates", () => {
    const net = new SimNetwork({ seed: 11, latencyMs: 5, jitterMs: 2 });
    let delivered = 0;
    net.onDeliver(() => delivered++);
    for (let i = 0; i < 100; i++) net.send(msg("a", "b", i));
    expect(net.inFlight()).toBe(100);
    net.runUntilSettled();
    expect(net.inFlight()).toBe(0);
    expect(delivered).toBe(100);
  });

  it("setLink blocks one direction only", () => {
    const net = new SimNetwork({ seed: 5, latencyMs: 1, jitterMs: 0 });
    const got: string[] = [];
    net.onDeliver((m) => got.push(`${m.from}>${m.to}`));
    net.setLink("a", "b", false);
    net.send(msg("a", "b", 0));
    net.send(msg("b", "a", 1));
    net.runUntilSettled();
    expect(got).toEqual(["b>a"]);
  });
});

// --- Cluster ---

describe("Cluster", () => {
  it("fans a local edit out to every peer exactly once", () => {
    const states = new Map<ReplicaId, FakeState>();
    const c = new Cluster(["alice", "bob", "carol"], { seed: 1, latencyMs: 5, jitterMs: 0 }, makeFakeFactory(states));
    c.localInsert("alice", 0, "x");
    c.runUntilSettled();
    expect(states.get("bob")!.received).toHaveLength(1);
    expect(states.get("carol")!.received).toHaveLength(1);
    expect(states.get("alice")!.received).toHaveLength(0);
    expect(c.converged()).toBe(true);
  });

  it("converged() is false while messages are in flight or pending exists", () => {
    const states = new Map<ReplicaId, FakeState>();
    const c = new Cluster(["a", "b"], { seed: 1, latencyMs: 10, jitterMs: 0 }, makeFakeFactory(states));
    expect(c.converged()).toBe(true);
    c.localInsert("a", 0, "x");
    expect(c.converged()).toBe(false);
    c.runUntilSettled();
    expect(c.converged()).toBe(true);
    states.get("b")!.pending = 1;
    expect(c.converged()).toBe(false);
    states.get("b")!.pending = 0;
    expect(c.converged()).toBe(true);
  });

  it("partition blocks cross-group traffic; heal restores it", () => {
    const states = new Map<ReplicaId, FakeState>();
    const c = new Cluster(["a", "b", "c"], { seed: 1, latencyMs: 5, jitterMs: 0 }, makeFakeFactory(states));
    c.partition(["a", "b"], ["c"]);
    c.localInsert("a", 0, "x");
    c.runUntilSettled();
    expect(states.get("c")!.received).toHaveLength(0);
    expect(states.get("b")!.received).toHaveLength(1);
    c.heal();
    c.localInsert("c", 0, "y");
    c.runUntilSettled();
    expect(states.get("a")!.received).toHaveLength(1);
    // Ops dropped during the partition are gone for good (no anti-entropy in
    // this layer): c never learns about "x", so convergence stays false.
    expect(c.converged()).toBe(false);
  });

  it("a partition with no lost ops converges after heal", () => {
    const states = new Map<ReplicaId, FakeState>();
    const c = new Cluster(["a", "b", "c"], { seed: 1, latencyMs: 5, jitterMs: 0 }, makeFakeFactory(states));
    c.partition(["a", "b"], ["c"]);
    c.runUntilSettled();
    c.heal();
    c.localInsert("a", 0, "x");
    c.localInsert("c", 0, "y");
    c.runUntilSettled();
    expect(c.converged()).toBe(true);
  });

  it("emits deliver/drop/converged events", () => {
    const states = new Map<ReplicaId, FakeState>();
    const c = new Cluster(["a", "b"], { seed: 2, latencyMs: 5, jitterMs: 0 }, makeFakeFactory(states));
    const events: string[] = [];
    c.onEvent((e) => events.push(e.type));
    c.localInsert("a", 0, "x");
    c.runUntilSettled();
    expect(events).toContain("local-op");
    expect(events).toContain("deliver");
    expect(events).toContain("converged");
    c.partition(["a"], ["b"]);
    c.localInsert("a", 0, "y");
    expect(events).toContain("drop");
  });

  it("texts() reports per-replica documents", () => {
    const states = new Map<ReplicaId, FakeState>();
    const c = new Cluster(["a", "b"], { seed: 1, latencyMs: 5, jitterMs: 0 }, makeFakeFactory(states));
    c.localInsert("a", 0, "hello");
    c.runUntilSettled();
    const t = c.texts();
    expect(t.a).toBe("hello");
    expect(t.b).toBe("hello");
  });

  it("works with the real FugueReplica (smoke)", () => {
    const c = new Cluster(["alice", "bob", "carol"], { seed: 42, latencyMs: 30, jitterMs: 20 });
    c.localInsert("alice", 0, "Hello from alice.");
    c.localInsert("bob", 17, " Bob was here.");
    c.localDelete("carol", 0, 5);
    c.runUntilSettled();
    expect(c.converged()).toBe(true);
    const texts = Object.values(c.texts());
    expect(new Set(texts).size).toBe(1);
    // carol was empty when deleting; both words grew from the same root gap and
    // FugueMax puts the greater replica id ("bob") first.
    expect(texts[0]).toBe(" Bob was here.Hello from alice.");
  });
});
