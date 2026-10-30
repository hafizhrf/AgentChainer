import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Build time only: the task library's source files by name, from a checkout's `catalog/workflows` and `agents`. */
export function readLibrarySources(repo: string): {
  workflows: Record<string, string>;
  roles: Record<string, string>;
} {
  const read = (dir: string, ext: string) =>
    Object.fromEntries(
      readdirSync(path.join(repo, dir))
        .filter((f) => f.endsWith(ext))
        .sort()
        .map((f) => [f, readFileSync(path.join(repo, dir, f), "utf8")]),
    );
  return { workflows: read("catalog/workflows", ".yaml"), roles: read("agents", ".md") };
}
