import { Check, Loader2, Pause, Square, X } from "lucide-react";
import { t } from "../i18n/index.ts";
import type { AgentStatus } from "../transcript.ts";

/** An agent's or tool call's state in words: "Running", "Done", … */
export function statusLabel(status: AgentStatus): string {
  switch (status) {
    case "running":
      return t("graph.status.running");
    case "paused":
      return t("graph.status.paused");
    case "done":
      return t("graph.status.done");
    case "stopped":
      return t("graph.status.stopped");
    default:
      return t("graph.status.failed");
  }
}

/** An agent's or tool call's state, as in the graph and the timeline. */
export function StatusIcon({ status }: { status: AgentStatus }) {
  const label = statusLabel(status);
  if (status === "running") return <Loader2 size={13} className="spin" aria-label={label} />;
  if (status === "done") return <Check size={13} aria-label={label} />;
  if (status === "stopped") return <Square size={13} aria-label={label} />;
  if (status === "paused") return <Pause size={13} aria-label={label} />;
  return <X size={13} aria-label={label} />;
}
