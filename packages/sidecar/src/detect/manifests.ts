/**
 * Small, forgiving readers for the few fields the detector needs from manifests (M2-06/M2-07). Not general TOML or
 * YAML parsers: they read what common projects write, and anything unexpected just yields less detail.
 */

/** TOML sections by header (`project`, `tool.poetry.dependencies`, …); the text before the first header is "". */
export function tomlSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let name = "";
  let body: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*(#.*)?$/.exec(line);
    if (header) {
      sections.set(name, `${sections.get(name) ?? ""}${body.join("\n")}\n`);
      name = header[1] ?? "";
      body = [];
    } else {
      body.push(line);
    }
  }
  sections.set(name, `${sections.get(name) ?? ""}${body.join("\n")}\n`);
  return sections;
}

/** A string value: `key = "value"`. */
export function tomlString(body: string | undefined, key: string): string | undefined {
  return body ? new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, "m").exec(body)?.[1] : undefined;
}

/** The text of the array `key = [ … ]`, brackets balanced and quoted text skipped (extras like `x[standard]`). */
export function tomlArray(body: string | undefined, key: string): string {
  if (!body) return "";
  const start = new RegExp(`^\\s*${key}\\s*=\\s*\\[`, "m").exec(body);
  if (!start) return "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = start.index + start[0].length - 1; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote && body[i - 1] !== "\\") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]" && --depth === 0) {
      return body.slice(start.index + start[0].length, i);
    }
  }
  return "";
}

/** Package names in a PEP 508 list, e.g. `dependencies = ["fastapi>=0.110", "uvicorn[standard]"]`. */
export function tomlDependencyNames(body: string | undefined): string[] {
  if (!body) return [];
  return [...body.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)[^"']*["']/g)].map((m) => normalizePyName(m[1] ?? ""));
}

/** Keys of a table such as `[tool.poetry.dependencies]`. */
export function tomlKeys(body: string | undefined): string[] {
  if (!body) return [];
  return [...body.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/gm)].map((m) => normalizePyName(m[1] ?? ""));
}

export const normalizePyName = (name: string) => name.toLowerCase().replace(/[._]/g, "-");

/** Package names from requirements.txt, ignoring comments, options (`-r`, `-e`) and URLs. */
export function requirementNames(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, "").trim())
    .filter((l) => l && !l.startsWith("-") && !l.includes("://"))
    .map((l) => normalizePyName(/^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(l)?.[0] ?? ""))
    .filter(Boolean);
}

/** Items of a top-level YAML list, e.g. `packages:` in pnpm-workspace.yaml. */
export function yamlList(text: string, key: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${key}\\s*:\\s*$`).test(l));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const item = /^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(line);
    if (item?.[1]) items.push(item[1]);
  }
  return items;
}

/** A top-level YAML scalar, e.g. `name: my_app`. */
export const yamlScalar = (text: string, key: string) =>
  new RegExp(`^${key}\\s*:\\s*["']?([^"'#\\n]+?)["']?\\s*$`, "m").exec(text)?.[1];

/** Target names of a Makefile or justfile: `test:` / `test arg:`, not variables (`X := 1`) or special targets. */
export function makeTargets(text: string): string[] {
  const targets = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\s+[^:=]*)?\s*:(?!=)/.exec(line);
    if (m?.[1] && !m[1].startsWith(".")) targets.add(m[1]);
  }
  return [...targets];
}
