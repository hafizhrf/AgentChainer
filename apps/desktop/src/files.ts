import type { FileStatus, WorkspaceFile } from "@agentchainer/protocol";
import type { Item, ToolItem } from "./transcript.ts";

/** File tree, agent edits and path helpers for the workspace panels (M1-25/M1-26). Pure, so it's unit-tested. */

export type TreeNode = {
  name: string;
  /** Relative to the workspace, `/`-separated. */
  path: string;
  file?: WorkspaceFile;
  children?: TreeNode[];
  /** Changed files at or below this node. */
  changes: number;
};

/** One-letter badges, as in most editors. */
export const STATUS_LETTER: Record<FileStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
};

/** Builds a folder tree from flat paths: folders first, then files, each sorted by name. */
export function buildTree(files: WorkspaceFile[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [], changes: 0 };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    parts.forEach((name, i) => {
      if (file.status) node.changes++;
      const path = parts.slice(0, i + 1).join("/");
      if (i === parts.length - 1) {
        node.children?.push({ name, path, file, changes: file.status ? 1 : 0 });
        return;
      }
      let dir = node.children?.find((c) => c.children && c.name === name);
      if (!dir) {
        dir = { name, path, children: [], changes: 0 };
        node.children?.push(dir);
      }
      node = dir;
    });
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .map((n) => (n.children ? { ...n, children: sort(n.children) } : n))
      .sort((a, b) => Number(!a.children) - Number(!b.children) || a.name.localeCompare(b.name));
  return sort(root.children ?? []);
}

const sep = (dir: string) => (dir.includes("\\") && !dir.includes("/") ? "\\" : "/");

/** Joins a workspace folder and a `/`-separated relative path with the folder's own separator. */
export function joinPath(cwd: string, rel: string): string {
  const s = sep(cwd);
  return `${cwd.replace(/[\\/]+$/, "")}${s}${rel.split("/").join(s)}`;
}

/** `abs` relative to `cwd` with `/` separators, or null when it's outside the workspace. */
export function relativeTo(cwd: string, abs: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = `${norm(cwd)}/`;
  const file = norm(abs);
  return file.startsWith(root) ? file.slice(root.length) : null;
}

/** Tools that change files and say which one; Bash changes only show up in git status. */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export type TurnEdits = { prompt: string; files: string[] };

/**
 * Files the agent changed with its file tools, per user turn, including subagents' edits (M1-26). Paths inside the
 * workspace are relative; others stay absolute. Failed calls are left out.
 */
export function agentEdits(items: Item[], cwd: string): TurnEdits[] {
  const turns: TurnEdits[] = [];
  let current: TurnEdits | null = null;
  const add = (tool: ToolItem) => {
    if (!EDIT_TOOLS.has(tool.name) || tool.status === "error") return;
    const input = (tool.input ?? {}) as Record<string, unknown>;
    const target = input.file_path ?? input.notebook_path;
    if (typeof target !== "string") return;
    const file = relativeTo(cwd, target) ?? target;
    current ??= { prompt: "", files: [] };
    if (!current.files.includes(file)) current.files.push(file);
  };
  for (const item of items) {
    if (item.kind === "user") {
      if (current?.files.length) turns.push(current);
      current = { prompt: item.text, files: [] };
    } else if (item.kind === "tool") {
      add(item);
    } else if (item.kind === "agent") {
      for (const child of item.children) if (child.kind === "tool") add(child);
    }
  }
  if (current?.files.length) turns.push(current);
  return turns;
}
