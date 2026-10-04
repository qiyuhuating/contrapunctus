// Fugue Max Tree list CRDT, after:
// Weidner & Kleppmann, "The Art of the Fugue: Minimizing Interleaving in
// Collaborative Text Editing" (arXiv:2305.00583), and Weidner's explainer
// https://mattweidner.com/2022/10/21/basic-list-crdt.html
//
// Model: each element is a node (parent, side, causal dot). Document order is
// the in-order tree walk. Siblings on the same side are ordered by dot —
// FugueMax visits RIGHT siblings in reverse dot order, which is what keeps
// concurrent insert runs contiguous instead of interleaved.
import { ROOT_ID, type ItemId, type Op, type Side, type TreeView } from "./types.js";

export function idKey(id: ItemId): string {
  return `${id.replica}#${id.counter}`;
}

export const ROOT_KEY = idKey(ROOT_ID);

/** Lexicographic on (replica, counter). */
export function compareDots(a: ItemId, b: ItemId): number {
  if (a.replica !== b.replica) return a.replica < b.replica ? -1 : 1;
  return a.counter - b.counter;
}

export interface TreeNode {
  readonly id: ItemId;
  readonly char: string;
  readonly parent: ItemId;
  readonly side: Side;
  deleted: boolean;
}

export class FugueTree {
  private nodes = new Map<string, TreeNode>();
  // parentKey -> children per side. Left siblings ascending by dot,
  // right siblings DESCENDING by dot (FugueMax).
  private children = new Map<string, { L: TreeNode[]; R: TreeNode[] }>();
  private visibleCache: TreeNode[] | null = null;

  has(key: string): boolean {
    return this.nodes.has(key);
  }

  node(key: string): TreeNode | undefined {
    return this.nodes.get(key);
  }

  /** Adds a node whose parent is already present. Duplicate ids are ignored. */
  add(node: TreeNode): boolean {
    const key = idKey(node.id);
    if (this.nodes.has(key)) return false;
    this.nodes.set(key, node);
    const bucket = this.childrenOf(idKey(node.parent));
    const arr = bucket[node.side];
    // Insert keeping the side's order (L asc, R desc).
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const c = compareDots(arr[mid]!.id, node.id) * (node.side === "R" ? -1 : 1);
      if (c < 0) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, node);
    this.visibleCache = null;
    return true;
  }

  markDeleted(key: string): boolean {
    const n = this.nodes.get(key);
    if (!n || n.deleted) return false;
    n.deleted = true;
    this.visibleCache = null;
    return true;
  }

  /** True if `anc` is an ancestor of (or equal to) `desc`. */
  isAncestorOrSelf(anc: string, desc: string): boolean {
    let cur: string | undefined = desc;
    while (cur !== undefined) {
      if (cur === anc) return true;
      if (cur === ROOT_KEY) return false;
      const n = this.nodes.get(cur);
      if (!n) return false;
      cur = idKey(n.parent);
    }
    return false;
  }

  private childrenOf(parentKey: string): { L: TreeNode[]; R: TreeNode[] } {
    let c = this.children.get(parentKey);
    if (!c) {
      c = { L: [], R: [] };
      this.children.set(parentKey, c);
    }
    return c;
  }

  /** Whole visible document, in order. */
  visible(): TreeNode[] {
    if (this.visibleCache) return this.visibleCache;
    const out: TreeNode[] = [];
    const walk = (key: string) => {
      const c = this.children.get(key);
      for (const child of c?.L ?? []) subtree(child);
      if (key !== ROOT_KEY) {
        const n = this.nodes.get(key);
        if (n && !n.deleted) out.push(n);
      }
      for (const child of c?.R ?? []) subtree(child);
    };
    const subtree = (n: TreeNode) => walk(idKey(n.id));
    walk(ROOT_KEY);
    this.visibleCache = out;
    return out;
  }

  snapshotTree(): TreeView {
    const build = (key: string): TreeView => {
      if (key === ROOT_KEY) {
        const c = this.children.get(ROOT_KEY);
        const kids = c ? [...c.L, ...c.R].map((n) => build(idKey(n.id))) : [];
        return { id: "root", char: "\u0000", deleted: false, children: kids };
      }
      const n = this.nodes.get(key)!;
      const c = this.children.get(key);
      const kids = c ? [...c.L, ...c.R].map((x) => build(idKey(x.id))) : [];
      return {
        id: `${n.id.replica}#${n.id.counter}`,
        char: n.char,
        deleted: n.deleted,
        children: kids,
      };
    };
    return build(ROOT_KEY);
  }
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}
