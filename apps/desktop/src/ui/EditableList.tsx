import { Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { IconButton } from "./IconButton.tsx";

/**
 * An editable list of short texts: one field per row, a remove button, and Add. Enter in a row adds a row after it,
 * and Backspace in an empty row removes it, so a list can be typed without the mouse. `render` replaces the plain
 * field when a row needs more (e.g. a criterion with its check).
 */
export function EditableList<T>({
  label,
  items,
  onChange,
  empty,
  addLabel = "Add",
  placeholder,
  mono,
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
  text: (item: T) => string;
  withText: (item: T, text: string) => T;
  blank: () => T;
  /** More controls at the end of a row, before remove. */
  extra?: (item: T, set: (next: T) => void) => ReactNode;
}) {
  const fields = useRef<(HTMLInputElement | null)[]>([]);
  const [focus, setFocus] = useState<number | null>(null);

  useEffect(() => {
    if (focus === null) return;
    fields.current[focus]?.focus();
    setFocus(null);
  }, [focus]);

  const set = (i: number, next: T) => onChange(items.map((item, j) => (j === i ? next : item)));
  const insert = (at: number) => {
    onChange([...items.slice(0, at), blank(), ...items.slice(at)]);
    setFocus(at);
  };
  const remove = (i: number) => {
    onChange(items.filter((_, j) => j !== i));
    setFocus(i > 0 ? i - 1 : null);
  };

  return (
    <div className="editable-list">
      {items.length === 0 && empty && <p className="editable-empty muted">{empty}</p>}
      {items.map((item, i) => (
        // Rows have no identity of their own beyond their position; the fields are controlled, so this is safe.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above.
        <div key={i} className="editable-row">
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
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                insert(i + 1);
              } else if (e.key === "Backspace" && text(item) === "") {
                e.preventDefault();
                remove(i);
              }
            }}
          />
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
}) {
  return <EditableList {...props} text={(s) => s} withText={(_, t) => t} blank={() => ""} />;
}
