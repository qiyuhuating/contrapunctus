import { bench, describe } from "vitest";
import { Cluster, FugueReplica } from "../src/index.js";

function localInserts(replica: FugueReplica, count: number): void {
  for (let i = 0; i < count; i++) replica.insertAt(Math.floor(i / 2), "x");
}

describe("engine benchmarks", () => {
  bench("local insert: 1000 ops into one replica", () => {
    const r = new FugueReplica("bench");
    localInserts(r, 1000);
  });

  bench("remote apply: 1000 ops into a fresh replica", () => {
    const a = new FugueReplica("src");
    const ops: ReturnType<FugueReplica["insertAt"]> = [];
    for (let i = 0; i < 1000; i++) ops.push(...a.insertAt(Math.floor(i / 2), "x"));
    const b = new FugueReplica("dst");
    for (const op of ops) b.applyRemote(op);
  });

  bench("cluster sync: 3 replicas × 100 edits, settle", () => {
    const cluster = new Cluster(["a", "b", "c"], { seed: 1, latencyMs: 2, jitterMs: 1 });
    for (let i = 0; i < 100; i++) {
      const who = (["a", "b", "c"] as const)[i % 3]!;
      cluster.localInsert(who, Math.floor(i / 2), "y");
    }
    cluster.runUntilSettled();
  });
});
