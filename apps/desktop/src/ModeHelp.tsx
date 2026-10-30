import { PERMISSION_MODES, type PermissionMode } from "@agentchainer/protocol";
import * as Popover from "@radix-ui/react-popover";
import { CircleHelp } from "lucide-react";
import { MODE_HELP, MODE_NAMES } from "./options.ts";

/**
 * What each permission profile means (UX-05), next to the Composer's profile select: the select only has room for a
 * one-line hint. The session's current profile is marked.
 */
export function ModeHelp({ current }: { current: PermissionMode }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="ghost icon small"
          aria-label="What the profiles mean"
          title="What the profiles mean"
        >
          <CircleHelp size={14} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="mode-help" side="top" align="start" sideOffset={6}>
          <h3>Permission profiles</h3>
          <dl>
            {PERMISSION_MODES.map((m) => (
              <div key={m} className={m === current ? "current" : undefined}>
                <dt>
                  {MODE_NAMES[m]}
                  {m === current && <span className="muted"> · this session</span>}
                </dt>
                <dd>{MODE_HELP[m]}</dd>
              </div>
            ))}
          </dl>
          <p className="field-help">AgentChainer's guard blocks dangerous commands in every profile.</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
