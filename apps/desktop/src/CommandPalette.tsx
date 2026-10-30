import * as RadixDialog from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyFilterBy } from "./fuzzy.ts";

export type PaletteCommand = {
  id: string;
  /** Section it's listed under while the query is empty, e.g. "Session". */
  group: string;
  title: string;
  /** A quiet detail on the right, e.g. a folder path. */
  hint?: string;
  shortcut?: string | undefined;
  run: () => void;
};

/**
 * The command palette (UX-07, ⇧⌘P / Ctrl+Shift+P): every app action, open session and recent workspace, found by
 * fuzzy search. Arrow keys move, Enter runs, Esc closes. Built on Radix Dialog with `fuzzy.ts` (ADR-0008), so it
 * traps focus and is announced as a dialog with a combobox and a listbox.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: PaletteCommand[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const results = useMemo(
    // Titles and groups only: hints are paths, whose many letters would match almost any query.
    () => fuzzyFilterBy(query, commands, (c) => `${c.title} ${c.group}`, 80),
    [query, commands],
  );
  const grouped = !query.trim();

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the top.
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function run(c: PaletteCommand | undefined) {
    if (!c) return;
    onOpenChange(false);
    // After the dialog closes and gives focus back, so the command can move focus itself (a dialog, the composer).
    setTimeout(c.run, 0);
  }

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="palette-overlay" />
        <RadixDialog.Content className="palette" aria-describedby={undefined}>
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          <div className="palette-input">
            <Search size={15} aria-hidden />
            <input
              // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into.
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const step = e.key === "ArrowDown" ? 1 : -1;
                  setActive((i) => (results.length ? (i + step + results.length) % results.length : 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  run(results[active]);
                }
              }}
              placeholder="Type a command, a session or a folder…"
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-activedescendant={results[active] ? `palette-${active}` : undefined}
              spellCheck={false}
            />
          </div>
          <div className="palette-list" id="palette-list" role="listbox" ref={list} aria-label="Commands">
            {results.length === 0 && <div className="palette-empty muted">No matching commands.</div>}
            {results.map((c, i) => (
              <div key={c.id} role="presentation">
                {grouped && c.group !== results[i - 1]?.group && <div className="palette-group">{c.group}</div>}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: options are chosen from the input with the keyboard (arrows, Enter, aria-activedescendant); the click is for the mouse. */}
                <div
                  id={`palette-${i}`}
                  data-index={i}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === active}
                  className={`palette-item${i === active ? " active" : ""}`}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(c)}
                >
                  <span className="palette-title">{c.title}</span>
                  {c.hint && <span className="palette-hint">{c.hint}</span>}
                  {!grouped && <span className="palette-hint">{c.group}</span>}
                  {c.shortcut && <kbd>{c.shortcut}</kbd>}
                </div>
              </div>
            ))}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
