import { ArrowLeft, ArrowRight } from "lucide-react";
import { useState } from "react";
import { WorkspaceCard } from "../HomeView.tsx";

/**
 * New task with no folder chosen yet (UX-06): the workspace comes first, with Home's card (Open folder…, recent
 * folders, a typed path). Continue confirms it, so a path being typed doesn't open a half-typed workspace.
 */
export function WorkspaceStep({
  recent,
  homeDir,
  backLabel,
  onBack,
  onChoose,
}: {
  recent: string[];
  homeDir: string | null;
  backLabel: string;
  onBack: () => void;
  onChoose: (dir: string) => void;
}) {
  const [dir, setDir] = useState("");
  const chosen = dir.trim();
  return (
    <div className="setup-page task-page">
      <header className="setup-header">
        <button type="button" className="ghost small" onClick={onBack}>
          <ArrowLeft size={14} />
          {backLabel}
        </button>
        <div className="setup-title">
          <h1>New task</h1>
        </div>
        <span className="chip">Preview</span>
      </header>
      <div className="setup-scroll task-scroll">
        <p className="muted task-step-intro">
          A task works inside one project folder: Claude drafts its contract from that folder, and the run changes only
          files in it. Choose the folder first.
        </p>
        <WorkspaceCard cwd={dir} onChange={setDir} recent={recent} homeDir={homeDir}>
          <div className="card-footer">
            <span className="grow" />
            <button type="button" disabled={!chosen} onClick={() => onChoose(chosen)}>
              Continue
              <ArrowRight size={14} />
            </button>
          </div>
        </WorkspaceCard>
      </div>
    </div>
  );
}
