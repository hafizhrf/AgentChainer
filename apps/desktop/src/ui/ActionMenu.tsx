import * as Menu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";

export type MenuAction = {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
};

/** A "⋯" button that opens a menu of actions (Radix DropdownMenu). */
export function ActionMenu({ label, items, trigger }: { label: string; items: MenuAction[]; trigger?: ReactNode }) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        {trigger ?? (
          <button type="button" className="ghost icon" aria-label={label} title={label}>
            <MoreHorizontal size={16} />
          </button>
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="menu-content"
          align="end"
          sideOffset={4}
          // An action may have moved focus on purpose (a rename field, a dialog): don't pull it back to the trigger.
          onCloseAutoFocus={(e) => {
            if (document.activeElement && document.activeElement !== document.body) e.preventDefault();
          }}
        >
          {items.map((item) => (
            <Menu.Item
              key={item.label}
              className={`menu-item${item.danger ? " danger" : ""}`}
              onSelect={item.onSelect}
              {...(item.disabled ? { disabled: true } : {})}
            >
              {item.label}
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
