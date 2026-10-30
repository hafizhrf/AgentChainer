// Monaco, bundled locally (no CDN): the editor core, syntax highlighting for common languages, and its one worker.
// Loaded lazily with the diff viewer (M1-27) and the transcript's code blocks (UX-04), so app start-up doesn't pay
// for it.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution";
// The icon font of the diff gutter and widgets; `editor.api` alone doesn't include it.
import "monaco-editor/features/codicon/register";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

import { isDark, onThemeChange } from "./appearance.ts";
import { fenceLanguage } from "./monaco-lang.ts";

window.MonacoEnvironment = { getWorker: () => new EditorWorker() };

/** Monaco's theme is global: the diff viewer and colorized code blocks follow the app's theme together. */
export const monacoTheme = () => (isDark() ? "vs-dark" : "vs");
monaco.editor.setTheme(monacoTheme());
onThemeChange(() => monaco.editor.setTheme(monacoTheme()));

/**
 * A code block's text as highlighted HTML (UX-04), or null for plain text. Monaco's colorizer escapes the text, so
 * the result is only its own spans.
 */
export async function colorize(code: string, fence: string): Promise<string | null> {
  const id = fenceLanguage(fence, monaco.languages.getLanguages());
  return id === "plaintext" ? null : monaco.editor.colorize(code, id, { tabSize: 2 });
}

/** Monaco's language id for a file name, by extension; plain text when unknown. */
export function languageFor(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  const ext = name.includes(".") ? `.${name.split(".").at(-1)?.toLowerCase()}` : "";
  return (
    monaco.languages.getLanguages().find((l) => l.extensions?.includes(ext) || l.filenames?.includes(name))?.id ??
    "plaintext"
  );
}

export { monaco };
