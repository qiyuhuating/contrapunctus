// Contract stubs — agent A replaces/extends. Signatures per DESIGN.md §3.
export type ReplicaId = string;
export type Side = "L" | "R";

export interface ItemId {
  replica: ReplicaId;
  counter: number;
}

export interface Op {
  kind: "insert" | "delete";
  id: ItemId;
  char?: string;
  parent?: ItemId;
  side?: Side;
  seq: number;
  /** Issuing replica (additive contract field; defaults to id.replica). */
  from?: ReplicaId;
}

export interface TreeView {
  id: string;
  char: string;
  deleted: boolean;
  children: TreeView[];
}

export const ROOT_ID: ItemId = { replica: "", counter: -1 };
