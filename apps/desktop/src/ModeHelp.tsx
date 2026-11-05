import { PERMISSION_MODES, type PermissionMode } from "@agentchainer/protocol";
import * as Popover from "@radix-ui/react-popover";
import { CircleHelp } from "lucide-react";
import { t } from "./i18n/index.ts";
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
          aria-label={t("shell.modeHelp.label")}
          title={t("shell.modeHelp.label")}
        >
          <CircleHelp size={14} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="mode-help" side="top" align="start" sideOffset={6}>
          <h3>{t("shell.modeHelp.title")}</h3>
          <dl>
            {PERMISSION_MODES.map((m) => (
              <div key={m} className={m === current ? "current" : undefined}>
                <dt>
                  {MODE_NAMES[m]}
                  {m === current && <span className="muted"> {t("shell.modeHelp.thisSession")}</span>}
                </dt>
                <dd>{MODE_HELP[m]}</dd>
              </div>
            ))}
          </dl>
          <p className="field-help">{t("shell.modeHelp.guard")}</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
