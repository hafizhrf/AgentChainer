import { Check, Loader2, Pause, Square, X } from "lucide-react";
import type { AgentStatus } from "../transcript.ts";

/** An agent's or tool call's state, as in the graph and the timeline. */
export function StatusIcon({ status }: { status: AgentStatus }) {
  if (status === "running") return <Loader2 size={13} className="spin" aria-label="Running" />;
  if (status === "done") return <Check size={13} aria-label="Done" />;
  if (status === "stopped") return <Square size={13} aria-label="Stopped" />;
  if (status === "paused") return <Pause size={13} aria-label="Paused" />;
  return <X size={13} aria-label="Failed" />;
}
