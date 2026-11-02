import type { TierWorkflow } from "@agentchainer/protocol";
import { Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { request } from "../sidecar.ts";

/**
 * Before a run, says when the tier runs the project's own workflow instead of the app's (M6-04): the file is
 * repository content, so a person sees it before starting, not only in the evidence afterwards.
 */
export function ProjectWorkflowNote({ cwd, tier }: { cwd: string; tier: TierWorkflow["tier"] | undefined }) {
  const [workflow, setWorkflow] = useState<TierWorkflow | null>(null);

  useEffect(() => {
    let live = true;
    if (!tier) return;
    request("workflow.list", { cwd })
      .then((r) => {
        if (live) setWorkflow(r.workflows.find((w) => w.tier === tier) ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [cwd, tier]);

  if (workflow?.source !== "project") return null;
  return (
    <span className="muted task-workflow-note" title={workflow.description}>
      <Workflow size={13} aria-hidden /> Runs the project's {tier} workflow, <code>{workflow.file}</code>
    </span>
  );
}
