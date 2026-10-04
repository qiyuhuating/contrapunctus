// Deterministic chaos network simulator + Cluster orchestration.
// All randomness flows through one mulberry32 stream: same seed, same schedule.
import { FugueReplica } from "../crdt/index.js";
import type { Op, ReplicaId } from "../crdt/types.js";
import { mulberry32 } from "../rng.js";

export interface SimNetOptions {
  seed?: number;
  latencyMs?: number;
  jitterMs?: number;
  dropRate?: number;
  dupRate?: number;
  reorder?: boolean;
}

export interface OpMessage {
  from: ReplicaId;
  to: ReplicaId;
  op: Op;
}

export interface NetStats {
  sent: number;
  delivered: number;
  dropped: number;
  duplicated: number;
}

interface Scheduled {
  deliverAt: number;
  order: number;
  msg: OpMessage;
}

const DEFAULTS = {
  seed: 1,
  latencyMs: 40,
  jitterMs: 10,
  dropRate: 0,
  dupRate: 0,
  reorder: true,
} as const;

export class SimNetwork {
  private o: Required<SimNetOptions>;
  private rng: () => number;
  private queue: Scheduled[] = [];
  private linksDown = new Set<string>();
  private deliverFn: ((msg: OpMessage) => void) | null = null;
  private dropFn: ((msg: OpMessage) => void) | null = null;
  private clock = 0;
  private orderSeq = 0;
  private counters: NetStats = { sent: 0, delivered: 0, dropped: 0, duplicated: 0 };

  constructor(opts: SimNetOptions = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.rng = mulberry32(this.o.seed);
  }

  onDeliver(fn: (msg: OpMessage) => void): void {
    this.deliverFn = fn;
  }

  onDrop(fn: (msg: OpMessage) => void): void {
    this.dropFn = fn;
  }

  setLink(from: ReplicaId, to: ReplicaId, up: boolean): void {
    const key = `${from}\u0000${to}`;
    if (up) this.linksDown.delete(key);
    else this.linksDown.add(key);
  }

  setLatency(ms: number): void {
    this.o.latencyMs = ms;
  }
  setJitter(ms: number): void {
    this.o.jitterMs = ms;
  }
  setDropRate(rate: number): void {
    this.o.dropRate = rate;
  }
  setDupRate(rate: number): void {
    this.o.dupRate = rate;
  }
  setReorder(reorder: boolean): void {
    this.o.reorder = reorder;
  }

  send(msg: OpMessage): void {
    this.counters.sent++;
    if (this.linksDown.has(linkKey(msg.from, msg.to))) {
      this.counters.dropped++;
      this.dropFn?.(msg);
      return;
    }
    this.schedule(msg);
    if (this.rng() < this.o.dupRate) {
      this.counters.duplicated++;
      this.schedule(msg);
    }
  }

  private schedule(msg: OpMessage): void {
    if (this.rng() < this.o.dropRate) {
      this.counters.dropped++;
      this.dropFn?.(msg);
      return;
    }
    const delay = this.o.latencyMs + this.rng() * this.o.jitterMs;
    this.queue.push({ deliverAt: this.clock + delay, order: this.orderSeq++, msg });
  }

  /** Advances the virtual clock by `ms`, delivering everything that comes due. */
  step(ms: number): void {
    const target = this.clock + ms;
    this.clock = target;
    if (this.o.reorder) {
      const due = this.queue.filter((s) => s.deliverAt <= target);
      this.queue = this.queue.filter((s) => s.deliverAt > target);
      due.sort((a, b) => a.deliverAt - b.deliverAt || a.order - b.order);
      for (const s of due) this.deliverOne(s);
    } else {
      // Per-pair FIFO: the pair's earliest-order message gates the rest even
      // when it is still in flight, so jitter may delay but never reorder.
      let progress = true;
      while (progress) {
        progress = false;
        for (const s of [...this.pairHeads().values()].sort((a, b) => a.order - b.order)) {
          if (s.deliverAt > target) continue;
          this.queue = this.queue.filter((x) => x !== s);
          this.deliverOne(s);
          progress = true;
        }
      }
    }
  }

  /** Per pair, the earliest-order message — the one allowed to deliver next. */
  private pairHeads(): Map<string, Scheduled> {
    const heads = new Map<string, Scheduled>();
    for (const s of this.queue) {
      const k = linkKey(s.msg.from, s.msg.to);
      const cur = heads.get(k);
      if (!cur || s.order < cur.order) heads.set(k, s);
    }
    return heads;
  }

  private deliverOne(s: Scheduled): void {
    if (this.linksDown.has(linkKey(s.msg.from, s.msg.to))) {
      this.counters.dropped++;
      this.dropFn?.(s.msg);
      return;
    }
    this.counters.delivered++;
    this.deliverFn?.(s.msg);
  }

  /** Steps until the queue drains (or maxMs of virtual time passes). */
  runUntilSettled(maxMs = 60000): void {
    while (this.queue.length > 0 && this.clock < maxMs) {
      // The next event is the earliest delivery among pair heads — a blocked
      // head pushes the whole pair forward, so stepping to it always progresses.
      const candidates = this.o.reorder
        ? this.queue
        : [...this.pairHeads().values()];
      let next = Infinity;
      for (const s of candidates) if (s.deliverAt < next) next = s.deliverAt;
      if (!Number.isFinite(next) || next <= this.clock) break;
      this.step(next - this.clock);
    }
  }

  inFlight(): number {
    return this.queue.length;
  }

  now(): number {
    return this.clock;
  }

  stats(): NetStats {
    return { ...this.counters };
  }
}

function linkKey(from: ReplicaId, to: ReplicaId): string {
  return `${from}\u0000${to}`;
}

export type ClusterEvent =
  | { type: "local-op"; replica: ReplicaId; ops: Op[] }
  | { type: "deliver"; from: ReplicaId; to: ReplicaId; op: Op; at: number }
  | { type: "drop"; from: ReplicaId; to: ReplicaId; op: Op; at: number }
  | { type: "converged"; at: number };

export class Cluster {
  readonly ids: ReplicaId[];
  private net: SimNetwork;
  private reps = new Map<ReplicaId, FugueReplica>();
  private listeners: ((e: ClusterEvent) => void)[] = [];
  private wasConverged: boolean;

  constructor(ids: ReplicaId[], opts: SimNetOptions = {}, replicaFactory?: (id: ReplicaId) => FugueReplica) {
    this.ids = [...ids];
    this.net = new SimNetwork(opts);
    this.net.onDeliver((msg) => {
      this.reps.get(msg.to)!.applyRemote(msg.op);
      this.emit({ type: "deliver", from: msg.from, to: msg.to, op: msg.op, at: this.net.now() });
    });
    this.net.onDrop((msg) => {
      this.emit({ type: "drop", from: msg.from, to: msg.to, op: msg.op, at: this.net.now() });
    });
    const factory = replicaFactory ?? ((id: ReplicaId) => new FugueReplica(id));
    for (const id of this.ids) this.reps.set(id, factory(id));
    this.wasConverged = this.converged();
  }

  onEvent(cb: (e: ClusterEvent) => void): void {
    this.listeners.push(cb);
  }

  replica(id: ReplicaId): FugueReplica {
    return this.reps.get(id)!;
  }

  localInsert(id: ReplicaId, index: number, text: string): void {
    const ops = this.replica(id).insertAt(index, text);
    this.emit({ type: "local-op", replica: id, ops });
    this.broadcast(id, ops);
    if (ops.length > 0) this.wasConverged = false;
  }

  localDelete(id: ReplicaId, index: number, length: number): void {
    const ops = this.replica(id).deleteRange(index, length);
    this.emit({ type: "local-op", replica: id, ops });
    this.broadcast(id, ops);
    if (ops.length > 0) this.wasConverged = false;
  }

  private broadcast(from: ReplicaId, ops: Op[]): void {
    for (const op of ops) {
      for (const peer of this.ids) {
        if (peer === from) continue;
        this.net.send({ from, to: peer, op });
      }
    }
  }

  partition(groupA: ReplicaId[], groupB: ReplicaId[]): void {
    for (const a of groupA) {
      for (const b of groupB) {
        if (a === b) continue;
        this.net.setLink(a, b, false);
        this.net.setLink(b, a, false);
      }
    }
  }

  heal(): void {
    for (const a of this.ids) {
      for (const b of this.ids) {
        if (a !== b) this.net.setLink(a, b, true);
      }
    }
  }

  setLatency(ms: number): void {
    this.net.setLatency(ms);
  }
  setJitter(ms: number): void {
    this.net.setJitter(ms);
  }
  setDropRate(rate: number): void {
    this.net.setDropRate(rate);
  }
  setDupRate(rate: number): void {
    this.net.setDupRate(rate);
  }
  setReorder(reorder: boolean): void {
    this.net.setReorder(reorder);
  }

  step(ms: number): void {
    this.net.step(ms);
    this.checkConverged();
  }

  runUntilSettled(maxMs?: number): void {
    this.net.runUntilSettled(maxMs);
    this.checkConverged();
  }

  /** Live network stats snapshot (for the demo console). */
  stats(): NetStats {
    return this.net.stats();
  }

  inFlight(): number {
    return this.net.inFlight();
  }

  now(): number {
    return this.net.now();
  }

  /**
   * True when every replica holds the same visible text, nothing is buffered,
   * and no message is in flight. (In-flight == 0 matters for the demo meter:
   * equal texts mid-flight are about to change.)
   */
  converged(): boolean {
    if (this.net.inFlight() > 0) return false;
    const reps = [...this.reps.values()];
    const first = reps[0];
    if (!first) return true;
    const text = first.getText();
    return reps.every((r) => !r.hasPending() && r.getText() === text);
  }

  texts(): Record<ReplicaId, string> {
    const out: Record<ReplicaId, string> = {};
    for (const [id, rep] of this.reps) out[id] = rep.getText();
    return out;
  }

  private checkConverged(): void {
    const c = this.converged();
    if (c && !this.wasConverged) this.emit({ type: "converged", at: this.net.now() });
    this.wasConverged = c;
  }

  private emit(e: ClusterEvent): void {
    for (const cb of this.listeners) cb(e);
  }
}
