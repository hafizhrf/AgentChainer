// Monaco, bundled locally (no CDN): the editor core, syntax highlighting for common languages, and its one worker.
// Loaded lazily with the diff viewer (M1-27), so app start-up doesn't pay for it.
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

window.MonacoEnvironment = { getWorker: () => new EditorWorker() };

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
