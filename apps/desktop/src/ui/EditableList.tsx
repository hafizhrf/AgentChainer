import { Plus, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "./IconButton.tsx";
import { oneLine } from "./listText.ts";

/**
 * Sets a wrapping field's height to its text (UX-11). CSS `field-sizing: content` isn't available in every webview the
 * app runs in (WKWebView on older macOS), so it's measured.
 */
function autosize(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  // `scrollHeight` leaves out the borders, which border-box sizing counts.
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

/**
 * An editable list of short texts: one field per row, a remove button, and Add. Enter in a row adds a row after it,
 * and Backspace in an empty row removes it, so a list can be typed without the mouse. `extra` adds controls to a row
 * (e.g. a criterion's check). `multiline` rows wrap and grow with their text instead of cutting it off; a row is still
 * one item, so Enter adds the next one.
 */
export function EditableList<T>({
  label,
  items,
  onChange,
  empty,
  addLabel = "Add",
  placeholder,
  mono,
  multiline,
  text,
  withText,
  blank,
  extra,
}: {
  /** The accessible name of the list; rows are named "<label> 1", "<label> 2", … */
  label: string;
  items: T[];
  onChange: (items: T[]) => void;
  /** Shown when the list is empty. */
  empty?: ReactNode;
  addLabel?: string;
  placeholder?: string;
  /** Monospace fields, for paths. */
  mono?: boolean;
  /** Rows that wrap and grow, for sentences. */
  multiline?: boolean;
  text: (item: T) => string;
  withText: (item: T, text: string) => T;
  blank: () => T;
  /** More controls at the end of a row, before remove. */
  extra?: (item: T, set: (next: T) => void) => ReactNode;
}) {
  const fields = useRef<(HTMLInputElement | HTMLTextAreaElement | null)[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<number | null>(null);

  useEffect(() => {
    if (focus === null) return;
    fields.current[focus]?.focus();
    setFocus(null);
  }, [focus]);

  // Wrapped rows take the height of their text, again when the list gets narrower or wider.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measures when the items change.
  useLayoutEffect(() => {
    if (!multiline) return;
    const grow = () => {
      for (const f of fields.current) if (f instanceof HTMLTextAreaElement) autosize(f);
    };
    grow();
    // Only a new width re-wraps the text; the heights set here would otherwise trigger the observer again.
    let width = list.current?.clientWidth ?? 0;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.width ?? 0;
      if (next === width) return;
      width = next;
      grow();
    });
    if (list.current) observer.observe(list.current);
    return () => observer.disconnect();
  }, [multiline, items]);

  const set = (i: number, next: T) => onChange(items.map((item, j) => (j === i ? next : item)));
  const insert = (at: number) => {
    onChange([...items.slice(0, at), blank(), ...items.slice(at)]);
    setFocus(at);
  };
  const remove = (i: number) => {
    onChange(items.filter((_, j) => j !== i));
    setFocus(i > 0 ? i - 1 : null);
  };

  const keys = (item: T, i: number) => (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      insert(i + 1);
    } else if (e.key === "Backspace" && text(item) === "") {
      e.preventDefault();
      remove(i);
    }
  };

  return (
    <div className={`editable-list${multiline ? " multiline" : ""}`} ref={list}>
      {items.length === 0 && empty && <p className="editable-empty muted">{empty}</p>}
      {items.map((item, i) => (
        // Rows have no identity of their own beyond their position; the fields are controlled, so this is safe.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above.
        <div key={i} className="editable-row">
          {multiline ? (
            <textarea
              ref={(el) => {
                fields.current[i] = el;
              }}
              rows={1}
              value={text(item)}
              placeholder={placeholder}
              aria-label={`${label} ${i + 1}`}
              onChange={(e) => set(i, withText(item, oneLine(e.target.value)))}
              onKeyDown={keys(item, i)}
            />
          ) : (
            <input
              ref={(el) => {
                fields.current[i] = el;
              }}
              className={mono ? "mono" : undefined}
              value={text(item)}
              placeholder={placeholder}
              aria-label={`${label} ${i + 1}`}
              spellCheck={!mono}
              onChange={(e) => set(i, withText(item, e.target.value))}
              onKeyDown={keys(item, i)}
            />
          )}
          {extra?.(item, (next) => set(i, next))}
          <IconButton label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => remove(i)}>
            <X size={14} />
          </IconButton>
        </div>
      ))}
      <button type="button" className="ghost small editable-add" onClick={() => insert(items.length)}>
        <Plus size={14} />
        {addLabel}
      </button>
    </div>
  );
}

/** The common case: a list of strings. */
export function StringList(props: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  empty?: ReactNode;
  addLabel?: string;
  placeholder?: string;
  mono?: boolean;
  multiline?: boolean;
}) {
  return <EditableList {...props} text={(s) => s} withText={(_, t) => t} blank={() => ""} />;
}
