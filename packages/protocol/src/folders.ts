/**
 * A multi-folder workspace's folders (M8-01, docs/design/workspaces-and-fleet.md §5.1): the rules the New workspace
 * dialog and the sidecar both apply, so a session never gets a folder the dialog would refuse. Paths are compared as
 * text, the way Windows and POSIX spell them; whether a folder exists is the sidecar's to check.
 */

/** `C:\a\` and `c:/a` are the same folder on Windows; `/a/` and `/a` everywhere. */
export function folderKey(dir: string, windows = /^[a-zA-Z]:[\\/]|^\\\\/.test(dir)): string {
  const slashed = dir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return windows ? slashed.toLowerCase() : slashed;
}

const isRoot = (key: string) => key === "" || /^[a-z]:$/i.test(key) || key === "/";
const isAbsolute = (dir: string) => /^[a-zA-Z]:[\\/]|^\\\\|^\//.test(dir.trim());
const within = (inner: string, outer: string) => inner.startsWith(`${outer}/`);

/**
 * Why these folders can't make a workspace, one reason per problem; empty when they can. The primary folder is the
 * first. Each must be absolute, none may be the home folder or a filesystem root, none may repeat, and none may sit
 * inside another (that folder is already in).
 */
export function folderProblems(folders: string[], home: string | null): string[] {
  const problems: string[] = [];
  const homeKey = home ? folderKey(home) : null;
  const keys = folders.map((f) => folderKey(f));
  for (const [i, dir] of folders.entries()) {
    const key = keys[i] ?? "";
    const name = dir.trim() || "(empty)";
    if (!isAbsolute(dir)) problems.push(`${name}: use a full path.`);
    else if (isRoot(key)) problems.push(`${name}: a whole drive is too much to hand an agent.`);
    else if (homeKey && key === homeKey) problems.push(`${name}: your home folder is too much to hand an agent.`);
    else if (keys.indexOf(key) !== i) problems.push(`${name} is in the list twice.`);
    else {
      // A root is refused on its own; it isn't also reported as what the others are inside.
      const outer = keys.find((k, j) => j !== i && !isRoot(k) && within(key, k));
      if (outer !== undefined) problems.push(`${name} is inside ${folders[keys.indexOf(outer)]}, which is already in.`);
    }
  }
  return problems;
}
