import type { MemoryFile, MemoryProject } from "@agentchainer/protocol";

/** About how many tokens a file costs Claude: roughly 4 bytes a token in English prose. Always shown as "about". */
export const approxTokens = (bytes: number) => Math.round(bytes / 4);

/** The editor's groups, in the order Claude loads them. */
export const MEMORY_KINDS = ["project", "local", "folder", "user"] as const;

export function groupFiles(files: MemoryFile[]) {
  return MEMORY_KINDS.map((kind) => ({ kind, files: files.filter((f) => f.kind === kind) })).filter(
    (g) => g.files.length > 0,
  );
}

/** Problems first, so the projects that need a look are at the top; then by folder. */
const RANK: Record<MemoryProject["status"], number> = { refused: 0, missing: 1, long: 2, noTest: 3, gone: 4, ok: 5 };

export function sortProjects(projects: MemoryProject[]): MemoryProject[] {
  return [...projects].sort((a, b) => RANK[a.status] - RANK[b.status] || a.cwd.localeCompare(b.cwd));
}

/** The file to open first: the project's own, else the first one there is. */
export function firstFile(files: MemoryFile[]): MemoryFile | undefined {
  return files.find((f) => f.kind === "project") ?? files[0];
}
