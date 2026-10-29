import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";

export type Option = { value: string; label: string; hint?: string; disabled?: boolean };

/** Radix doesn't allow "" as an item value, and "" means "default" across the app's settings. */
const EMPTY = "__default__";

/**
 * A select (Radix Select) styled by the design system. `compact` is the chip-sized variant for toolbars.
 */
export function Select({
  value,
  onChange,
  options,
  label,
  compact,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  /** Accessible name; also the tooltip of compact selects. */
  label: string;
  compact?: boolean;
  disabled?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <RadixSelect.Root
      value={value === "" ? EMPTY : value}
      onValueChange={(v) => onChange(v === EMPTY ? "" : v)}
      {...(disabled ? { disabled } : {})}
    >
      <RadixSelect.Trigger className={`select-trigger${compact ? " compact" : ""}`} aria-label={label} title={label}>
        <RadixSelect.Value>{current?.label ?? value}</RadixSelect.Value>
        <RadixSelect.Icon>
          <ChevronDown size={14} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="select-content" position="popper" sideOffset={4}>
          <RadixSelect.Viewport>
            {options.map((o) => (
              <RadixSelect.Item
                key={o.value}
                value={o.value === "" ? EMPTY : o.value}
                className="select-item"
                {...(o.disabled ? { disabled: true } : {})}
              >
                <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                {o.hint && <span className="select-hint">{o.hint}</span>}
                <RadixSelect.ItemIndicator className="select-check">
                  <Check size={14} />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
