import type { Finding, Methods } from "@agentchainer/protocol";
import { useCallback, useEffect, useState } from "react";
import { BootstrapPlanView } from "./BootstrapPlanView.tsx";
import type { Confirm } from "./Dialog.tsx";
import { request } from "./sidecar.ts";

type Scan = Methods["workspace.scan"]["result"];

const ICON: Record<Finding["status"], string> = { ok: "✓", info: "ℹ", warn: "!", missing: "✕" };
const AREA: Record<Finding["area"], string> = {
  agent: "Agent setup",
  quality: "Project checks",
  hygiene: "Secrets hygiene",
  git: "Git",
};

/**
 * Readiness report (M2-08/M2-09): what the workspace is made of, the commands found for it, and what it lacks for
 * agent work. Every gap names its fix; applying fixes arrives with the bootstrap plan (M2-11).
 */
export function SetupReport({ cwd, confirm }: { cwd: string; confirm: Confirm }) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setScan(await request("workspace.scan", { cwd }));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    try {
      setSaved((await request("workspace.saveProfile", { cwd })).path);
    } catch (err) {
      setError(String(err));
    }
  }

  if (error) return <p className="warn">{error}</p>;
  if (!scan) return <p className="muted">Scanning…</p>;
  const { profile, findings } = scan;
  const gaps = findings.filter((f) => f.fix && f.status !== "ok");

  return (
    <div className="setup-report">
      <p className="muted">
        {profile.stacks.length ? profile.stacks.join(", ") : "No known stack"}
        {profile.monorepo ? ` · monorepo (${profile.monorepo})` : ""}
        {profile.ci.length ? ` · CI: ${profile.ci.join(", ")}` : ""}
      </p>

      <h3>
        Readiness: {gaps.length === 0 ? "nothing to fix" : `${gaps.length} thing${gaps.length > 1 ? "s" : ""} to fix`}
      </h3>
      {(Object.keys(AREA) as Finding["area"][]).map((area) => {
        const items = findings.filter((f) => f.area === area);
        if (items.length === 0) return null;
        return (
          <div key={area}>
            <h4>{AREA[area]}</h4>
            <ul className="findings">
              {items.map((f) => (
                <li key={f.id} className={`finding ${f.status}`} title={f.detail}>
                  <span className="finding-icon">{ICON[f.status]}</span>
                  <span>
                    {f.title}
                    {f.status !== "ok" && <span className="muted"> — {f.detail}</span>}
                    {f.fix && f.status !== "ok" && <span className="fix">Fix: {f.fix.label}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <BootstrapPlanView cwd={cwd} confirm={confirm} onChanged={() => void load()} />

      <h3>Packages and commands</h3>
      {profile.packages.length === 0 && <p className="muted">No manifests found.</p>}
      {profile.packages.map((p) => (
        <div key={`${p.path}-${p.stack}`} className="package">
          <div>
            <code>{p.path}</code> {p.stack} ({p.packageManager})
            {p.frameworks.length > 0 && <span className="muted"> · {p.frameworks.join(", ")}</span>}
          </div>
          <ul className="commands">
            {Object.entries(p.commands).map(([kind, c]) =>
              c ? (
                <li key={kind} title={`From ${c.source}`}>
                  <span className="muted">{kind}</span> <code>{c.run}</code>
                  {c.confidence !== "high" && <span className="badge">{c.confidence}</span>}
                </li>
              ) : null,
            )}
          </ul>
        </div>
      ))}

      <div className="row">
        <button type="button" className="link" onClick={() => void load()}>
          Rescan
        </button>
        <button type="button" className="link" onClick={() => void save()} title="Kept out of git">
          Save profile
        </button>
      </div>
      {saved && <p className="muted">Saved to {saved} (ignored by git).</p>}
    </div>
  );
}
