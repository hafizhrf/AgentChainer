import type { Methods } from "@agentchainer/protocol";
import { ArrowRight, CircleCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { request } from "../sidecar.ts";
import { gapsOf, STATUS_ICON } from "./Overview.tsx";

type Scan = Methods["workspace.scan"]["result"];

/** The Setup tab of the right panel: what the workspace is and its top gaps; the full setup opens as a page. */
export function SetupSummary({ cwd, onOpen }: { cwd: string; onOpen: () => void }) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    request("workspace.scan", { cwd })
      .then((s) => current && setScan(s))
      .catch((err: unknown) => current && setError(String(err)));
    return () => {
      current = false;
    };
  }, [cwd]);

  if (error) return <p className="warn">{error}</p>;
  if (!scan) return <p className="muted">Scanning…</p>;
  const gaps = gapsOf(scan.findings);
  const { profile } = scan;
  return (
    <div className="setup-summary">
      <p className="muted">
        {profile.stacks.length ? profile.stacks.join(", ") : "No known stack"}
        {profile.monorepo ? ` · monorepo (${profile.monorepo})` : ""}
        {profile.ci.length ? ` · CI: ${profile.ci.join(", ")}` : ""}
      </p>
      <div className={`summary-main${gaps.length ? " has-gaps" : ""}`}>
        {gaps.length === 0 && <CircleCheck size={18} />}
        <strong>
          {gaps.length === 0 ? "Ready for agent work" : `${gaps.length} thing${gaps.length > 1 ? "s" : ""} to fix`}
        </strong>
      </div>
      {gaps.length > 0 && (
        <ul className="findings">
          {gaps.slice(0, 3).map((f) => {
            const Icon = STATUS_ICON[f.status];
            return (
              <li key={f.id} className={`finding finding-${f.status}`}>
                <Icon size={16} className="finding-icon" />
                <div className="finding-text">
                  <span>{f.title}</span>
                  <span className="muted">{f.fix?.label}</span>
                </div>
              </li>
            );
          })}
          {gaps.length > 3 && <li className="muted">and {gaps.length - 3} more</li>}
        </ul>
      )}
      <button type="button" onClick={onOpen}>
        Open workspace settings
        <ArrowRight size={14} />
      </button>
      <p className="muted small-print">
        Review the readiness report, the bootstrap plan with exact previews, detected commands and past runs.
      </p>
    </div>
  );
}
