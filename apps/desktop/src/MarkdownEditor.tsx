import { useEffect, useRef } from "react";
import { monaco, monacoTheme } from "./monaco.ts";

/**
 * A Markdown file in an editable Monaco editor (CP-03): word wrap, no minimap, ⌘/Ctrl+S calls `onSave`. Loaded
 * lazily, like the diff viewer, so app start-up doesn't pay for Monaco. A new `value` from outside (another file, a
 * reload) replaces the text; typing reports through `onChange`.
 */
export default function MarkdownEditor({
  value,
  label,
  onChange,
  onSave,
}: {
  value: string;
  label: string;
  onChange: (text: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // The latest callbacks, so the editor is made once.
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  useEffect(() => {
    if (!host.current) return;
    const ed = monaco.editor.create(host.current, {
      value: "",
      language: "markdown",
      automaticLayout: true,
      wordWrap: "on",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 3,
      renderLineHighlight: "line",
      tabSize: 2,
      theme: monacoTheme(),
    });
    editor.current = ed;
    const changes = ed.onDidChangeModelContent(() => handlers.current.onChange(ed.getValue()));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => handlers.current.onSave());
    return () => {
      changes.dispose();
      ed.getModel()?.dispose();
      ed.dispose();
      editor.current = null;
    };
  }, []);

  // Its label for screen readers, set here so the editor itself is made once.
  useEffect(() => {
    editor.current?.updateOptions({ ariaLabel: label });
  }, [label]);

  useEffect(() => {
    const ed = editor.current;
    if (ed && ed.getValue() !== value) ed.setValue(value);
  }, [value]);

  return <div className="markdown-editor" ref={host} />;
}
