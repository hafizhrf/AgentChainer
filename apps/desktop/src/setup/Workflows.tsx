import type { Methods, TierWorkflow } from "@agentchainer/protocol";
import { Pencil, RefreshCw, Workflow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
import { request } from "../sidecar.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { WorkflowEditor } from "../workflows/WorkflowEditor.tsx";

type List = Methods["workflow.list"]["result"];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The workflow each tier runs in this workspace (M6-04; docs/design/deploy-and-canvas.md §9): the app's, or the
 * project's own `.agentchainer/workflows/<tier>.yaml` when it passes the app's checks. A file that doesn't is listed
 * with why, and the app's workflow runs instead. Edit opens a tier's workflow on the canvas.
 */
export function Workflows({ cwd, confirm }: { cwd: string; confirm: Confirm }) {
  const [list, setList] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TierWorkflow["tier"] | null>(null);

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

  if (editing) {
    return (
      <WorkflowEditor
        cwd={cwd}
        tier={editing}
        confirm={confirm}
        onClose={(changed) => {
          setEditing(null);
          if (changed) void load();
        }}
      />
    );
  }

  return (
    <div className="setup-scroll">
      <p className="muted">
        <Rich
          k="setup.workflows.intro"
          params={{ file: ".agentchainer/workflows/<tier>.yaml" }}
          tags={{ code: (s) => <code>{s}</code> }}
        />
      </p>
      <section className="card deploy-card">
        <div className="card-title">
          <Workflow size={16} aria-hidden />
          <h2>{t("setup.workflows.tiers")}</h2>
          <span className="grow" />
          <IconButton label={t("setup.workflows.checkAgain")} onClick={() => void load()}>
            <RefreshCw size={14} />
          </IconButton>
        </div>
        {error && <p className="warn">{error}</p>}
        {!list && !error && <p className="muted">{t("setup.workflows.reading")}</p>}
        <ul className="deploy-targets">
          {list?.workflows.map((w) => (
            <li key={w.tier}>
              <strong>{w.tier}</strong>
              <span className={`chip${w.source === "project" ? " on" : ""}`}>
                {w.source === "project" ? t("setup.workflows.sourceProject") : t("setup.workflows.sourceApp")}
              </span>
              <span className="grow muted deploy-detail" title={w.description}>
                {w.description}
              </span>
              {w.source === "project" ? (
                <code className="muted" title={`sha256 ${w.hash}`}>
                  {w.file} · {w.hash}
                </code>
              ) : (
                <span className="muted">{t("setup.workflows.idVersion", { id: w.id, version: w.version })}</span>
              )}
              <button type="button" className="ghost small" onClick={() => setEditing(w.tier)}>
                <Pencil size={13} />
                {t("setup.workflows.edit")}
              </button>
            </li>
          ))}
        </ul>
        {list && list.problems.length > 0 && (
          <div className="workflow-problems">
            {list.problems.map((p) => (
              <div key={p.file} className="callout">
                <strong>
                  <Rich
                    k="setup.workflows.notUsed"
                    params={{ file: p.file }}
                    tags={{ code: (s) => <code>{s}</code> }}
                  />
                </strong>
                {t("setup.workflows.appRunsInstead")}
                <pre>{p.error}</pre>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
