import type { Proposal } from "./generate.ts";

/**
 * Generator proposals waiting for review, per workspace and action. Kept in memory only: a restart of the agent
 * runtime drops them, and the plan asks to generate again.
 */
const store = new Map<string, Proposal>();
const key = (root: string, action: string) => `${root}\u0000${action}`;

export const proposals = {
  get: (root: string, action: string) => store.get(key(root, action)),
  set: (root: string, p: Proposal) => store.set(key(root, p.action), p),
  delete: (root: string, action: string) => store.delete(key(root, action)),
  /** All proposals for one workspace, by action. */
  of: (root: string) =>
    new Map([...store.values()].filter((p) => store.get(key(root, p.action)) === p).map((p) => [p.action, p])),
};
