import type { Methods } from "@agentchainer/protocol";
import { RefreshCw, Workflow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { request } from "../sidecar.ts";
import { IconButton } from "../ui/IconButton.tsx";

type List = Methods["workflow.list"]["result"];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The workflow each tier runs in this workspace (M6-04; docs/design/deploy-and-canvas.md §9): the app's, or the
 * project's own `.agentchainer/workflows/<tier>.yaml` when it passes the app's checks. A file that doesn't is listed
 * with why, and the app's workflow runs instead.
 */
export function Workflows({ cwd }: { cwd: string }) {
  const [list, setList] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await request("workflow.list", { cwd }));
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="setup-scroll">
      <p className="muted">
        The steps a task runs, by tier. A project can replace a tier's with its own{" "}
        <code>.agentchainer/workflows/&lt;tier&gt;.yaml</code>, shared through git; it's checked like the app's own, and
        a run keeps a copy of the one it started with.
      </p>
      <section className="card deploy-card">
        <div className="card-title">
          <Workflow size={16} aria-hidden />
          <h2>Tiers</h2>
          <span className="grow" />
          <IconButton label="Check again" onClick={() => void load()}>
            <RefreshCw size={14} />
          </IconButton>
        </div>
        {error && <p className="warn">{error}</p>}
        {!list && !error && <p className="muted">Reading the workflows…</p>}
        <ul className="deploy-targets">
          {list?.workflows.map((w) => (
            <li key={w.tier}>
              <strong>{w.tier}</strong>
              <span className={`chip${w.source === "project" ? " on" : ""}`}>
                {w.source === "project" ? "project" : "app"}
              </span>
              <span className="grow muted deploy-detail" title={w.description}>
                {w.description}
              </span>
              {w.source === "project" ? (
                <code className="muted" title={`sha256 ${w.hash}`}>
                  {w.file} · {w.hash}
                </code>
              ) : (
                <span className="muted">
                  {w.id} v{w.version}
                </span>
              )}
            </li>
          ))}
        </ul>
        {list && list.problems.length > 0 && (
          <div className="workflow-problems">
            {list.problems.map((p) => (
              <div key={p.file} className="callout">
                <strong>
                  <code>{p.file}</code> isn't used
                </strong>
                ; the app's workflow runs instead.
                <pre>{p.error}</pre>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
