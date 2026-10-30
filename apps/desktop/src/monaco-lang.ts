/** What Monaco knows about a language: `monaco.languages.getLanguages()`. */
export type LanguageInfo = { id: string; aliases?: string[]; extensions?: string[] };

/** Fence names models write that Monaco doesn't know by that name. */
const FENCE_ALIASES: Record<string, string> = {
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  console: "shell",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  cs: "csharp",
  kt: "kotlin",
  ps1: "powershell",
  jsonc: "json",
  toml: "ini",
};

/**
 * Monaco's language id for a code fence's info string (` ```ts `), through its ids, aliases and file extensions;
 * `plaintext` when there's none or it's unknown (UX-04).
 */
export function fenceLanguage(fence: string, languages: readonly LanguageInfo[]): string {
  const name = fence.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!name) return "plaintext";
  const known = (id: string) => languages.some((l) => l.id === id);
  const alias = FENCE_ALIASES[name];
  if (alias && known(alias)) return alias;
  const hit = languages.find(
    (l) =>
      l.id === name ||
      l.aliases?.some((a) => a.toLowerCase() === name) ||
      l.extensions?.some((e) => e.toLowerCase() === `.${name}`),
  );
  return hit?.id ?? "plaintext";
}
