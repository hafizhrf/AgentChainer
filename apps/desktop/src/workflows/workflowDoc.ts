import { type Document, isCollection, isMap, isScalar, isSeq, type Node, parseDocument, type YAMLSeq } from "yaml";
import { t } from "../i18n/index.ts";

/**
 * Edits to a workflow's YAML through the `yaml` Document API (M6-04, design §9), so the file's comments and layout
 * survive: the canvas changes one value or one step at a time, never by printing the whole workflow again. The text is
 * what gets saved; the graph is drawn from what it parses to.
 */

export type Path = (string | number)[];

/** The workflow the text holds, or the YAML syntax error that stops it from being read. */
export function readWorkflow(text: string): { data: Record<string, unknown> | null; yamlError: string | null } {
  const doc = parseDocument(text);
  if (doc.errors.length) return { data: null, yamlError: doc.errors[0]?.message ?? t("workflows.doc.invalidYaml") };
  const data = doc.toJS() as unknown;
  return {
    data: data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null,
    yamlError: null,
  };
}

function edit(text: string, change: (doc: Document) => void): string {
  const doc = parseDocument(text);
  if (doc.errors.length)
    throw new Error(
      t("workflows.doc.fixYamlFirst", { error: doc.errors[0]?.message ?? t("workflows.doc.doesNotParse") }),
    );
  change(doc);
  return doc.toString();
}

/** Small lists and maps of plain values print on one line, as the app's workflows write them. */
function compact(node: unknown): void {
  if (!isCollection(node)) return;
  const items = isMap(node) ? node.items.map((p) => p.value) : node.items;
  if (items.length <= 6 && items.every((v) => isScalar(v))) node.flow = true;
  for (const v of items) compact(v);
}

function nodeFor(doc: Document, value: unknown): Node {
  const node = doc.createNode(value);
  compact(node);
  return node;
}

/** Sets the value at `path` (a step's field, a limit, the gates…); `undefined` removes the key. */
export function setAt(text: string, path: Path, value: unknown): string {
  return edit(text, (doc) => {
    if (value === undefined) {
      doc.deleteIn(path);
      return;
    }
    if (value === null || typeof value !== "object") {
      doc.setIn(path, value);
      return;
    }
    doc.setIn(path, nodeFor(doc, value));
  });
}

function stepsOf(doc: Document, path: Path): YAMLSeq {
  const seq = doc.getIn(path, true);
  if (!isSeq(seq)) throw new Error(t("workflows.doc.noStepList"));
  // A comment above the first item belongs to the list in the Document; give it to the item, so it moves with it.
  const first = seq.items[0];
  if (seq.commentBefore && first && (isMap(first) || isScalar(first) || isSeq(first))) {
    first.commentBefore = first.commentBefore
      ? `${seq.commentBefore}
${first.commentBefore}`
      : seq.commentBefore;
    seq.commentBefore = undefined;
  }
  return seq;
}

/** Puts `step` into the list at `path` (a workflow's `steps`, or a group's `parallel`) at `index`. */
export function insertAt(text: string, path: Path, index: number, step: unknown): string {
  return edit(text, (doc) => {
    const seq = stepsOf(doc, path);
    seq.items.splice(Math.max(0, Math.min(index, seq.items.length)), 0, nodeFor(doc, step));
  });
}

/** Removes the item at `index` from the list at `path`; a comment above it goes with it. */
export function removeAt(text: string, path: Path, index: number): string {
  return edit(text, (doc) => {
    stepsOf(doc, path).items.splice(index, 1);
  });
}

/** Moves the item at `index` in the list at `path` by `delta` places, comments included. */
export function moveAt(text: string, path: Path, index: number, delta: number): string {
  return edit(text, (doc) => {
    const items = stepsOf(doc, path).items;
    const to = index + delta;
    if (to < 0 || to >= items.length) return;
    const [item] = items.splice(index, 1);
    items.splice(to, 0, item);
  });
}

/** An id no step has yet: `base`, then `base-2`, `base-3`… */
export function freshId(data: Record<string, unknown> | null, base: string): string {
  const taken = new Set<string>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.id === "string") taken.add(o.id);
      Object.values(o).forEach(visit);
    }
  };
  visit(data?.steps);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
