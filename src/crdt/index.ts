// Contract stub — agent A replaces with the real Fugue Max Tree implementation.
import type { ItemId, Op, ReplicaId, TreeView } from "./types.js";
import { ROOT_ID } from "./types.js";
import { FugueTree, graphemes, idKey, ROOT_KEY, type TreeNode } from "./fugue.js";

export * from "./types.js";
export { FugueTree, graphemes, idKey, ROOT_KEY, compareDots } from "./fugue.js";
export type { TreeNode } from "./fugue.js";

const ROOT = ROOT_ID;

/**
 * One voice in the fugue. Holds a Fugue Max Tree and buffers remote ops whose
 * parent has not arrived yet — applyRemote converges under any delivery order.
 */
export class FugueReplica {
  readonly id: ReplicaId;
  private tree = new FugueTree();
  private counter = 0;
  private seq = 0;
  private vv: Record<string, number> = {};
  private pendingIns: Op[] = [];
  private pendingDel: Op[] = [];

  constructor(id: ReplicaId) {
    this.id = id;
    this.vv[id] = 0;
  }

  insertAt(index: number, text: string): Op[] {
    const segs = graphemes(text);
    if (segs.length === 0) return [];
    const visible = this.tree.visible();
    const i = Math.max(0, Math.min(index, visible.length));
    const next = visible[i]; // right neighbor (undefined => end of document)
    let prev: TreeNode | undefined = i > 0 ? visible[i - 1] : undefined;
    const ops: Op[] = [];
    for (const char of segs) {
      const id: ItemId = { replica: this.id, counter: this.counter++ };
      const { parent, side } = this.choosePlacement(prev, next);
      this.tree.add({ id, char, parent, side, deleted: false });
      const op: Op = { kind: "insert", id, char, parent, side, seq: this.seq++, from: this.id };
      ops.push(op);
      this.bump(op);
      prev = this.tree.node(idKey(id))!;
    }
    return ops;
  }

  deleteRange(start: number, length: number): Op[] {
    if (length <= 0) return [];
    const visible = this.tree.visible();
    const from = Math.max(0, Math.min(start, visible.length));
    const to = Math.max(from, Math.min(start + length, visible.length));
    const ops: Op[] = [];
    for (let i = from; i < to; i++) {
      const node = visible[i]!;
      if (this.tree.markDeleted(idKey(node.id))) {
        const op: Op = { kind: "delete", id: node.id, seq: this.seq++, from: this.id };
        ops.push(op);
        this.bump(op);
      }
    }
    return ops;
  }

  applyRemote(op: Op): void {
    this.bump(op);
    if (op.kind === "insert") {
      if (this.tree.has(idKey(op.id))) return; // duplicated delivery
      if (op.parent !== undefined && op.parent.replica !== "" && !this.tree.has(idKey(op.parent))) {
        this.pendingIns.push(op);
        return;
      }
      this.insertNode(op);
    } else {
      if (this.tree.has(idKey(op.id))) {
        this.tree.markDeleted(idKey(op.id));
      } else {
        this.pendingDel.push(op); // delete raced ahead of its node
      }
    }
    this.flush();
  }

  /** Applies every pending op whose dependency has arrived; repeats until fixpoint. */
  private flush(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      if (this.pendingDel.length > 0) {
        const still: Op[] = [];
        for (const op of this.pendingDel) {
          if (this.tree.has(idKey(op.id))) {
            if (this.tree.markDeleted(idKey(op.id))) progressed = true;
          } else still.push(op);
        }
        this.pendingDel = still;
      }
      if (this.pendingIns.length > 0) {
        const still: Op[] = [];
        for (const op of this.pendingIns) {
          const unknownParent =
            op.parent !== undefined && op.parent.replica !== "" && !this.tree.has(idKey(op.parent));
          if (unknownParent) still.push(op);
          else {
            if (this.insertNode(op)) progressed = true;
          }
        }
        this.pendingIns = still;
      }
    }
  }

  private insertNode(op: Op): boolean {
    if (op.char === undefined || op.parent === undefined || op.side === undefined) return false;
    return this.tree.add({
      id: op.id,
      char: op.char,
      parent: op.parent,
      side: op.side,
      deleted: false,
    });
  }

  private bump(op: Op): void {
    const who = op.from ?? op.id.replica;
    const prev = this.vv[who] ?? -1;
    if (op.seq > prev) this.vv[who] = op.seq;
  }

  getText(): string {
    return this.tree
      .visible()
      .map((n) => n.char)
      .join("");
  }

  get length(): number {
    return this.tree.visible().length;
  }

  versionVector(): Readonly<Record<string, number>> {
    return { ...this.vv };
  }

  hasPending(): boolean {
    return this.pendingIns.length > 0 || this.pendingDel.length > 0;
  }

  pendingCount(): number {
    return this.pendingIns.length + this.pendingDel.length;
  }

  snapshotTree(): TreeView {
    return this.tree.snapshotTree();
  }
  private choosePlacement(
    prev: TreeNode | undefined,
    next: TreeNode | undefined,
  ): { parent: ItemId; side: "L" | "R" } {
    if (prev === undefined && next === undefined) return { parent: ROOT, side: "R" };
    if (prev === undefined) return { parent: next!.id, side: "L" };
    if (next === undefined) return { parent: prev.id, side: "R" };
    const prevIsAncestor = this.tree.isAncestorOrSelf(idKey(prev.id), idKey(next.id));
    return prevIsAncestor ? { parent: next.id, side: "L" } : { parent: prev.id, side: "R" };
  }
}
