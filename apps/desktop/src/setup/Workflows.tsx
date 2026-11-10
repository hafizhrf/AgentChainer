import {
  folderKey,
  type Methods,
  type TaskDefaults,
  type TaskDefaultsView,
  type TierWorkflow,
} from "@agentchainer/protocol";
import { Bot, Pencil, RefreshCw, Workflow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
import { request } from "../sidecar.ts";
import { folderName } from "../tabs.ts";
import type { AgentClis } from "../tasks/AgentPickers.tsx";
import { TaskDefaultsFields } from "../tasks/TaskDefaultsFields.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { WorkflowEditor } from "../workflows/WorkflowEditor.tsx";

type List = Methods["workflow.list"]["result"];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The workflow each tier runs in this workspace (M6-04; docs/design/deploy-and-canvas.md §9): the app's, or the
 * project's own `.agentchainer/workflows/<tier>.yaml` when it passes the app's checks. A file that doesn't is listed
 * with why, and the app's workflow runs instead. Edit opens a tier's workflow on the canvas.
 */
export function Workflows({
  cwd,
  confirm,
  workspaces = [],
}: {
  cwd: string;
  confirm: Confirm;
  /** Every workspace the app knows, for "Apply to all workspaces". */
  workspaces?: string[];
}) {
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
        <ul className="tier-list">
          {list?.workflows.map((w) => (
            <li key={w.tier} className="tier-row">
              <span className={`tier-badge${w.source === "project" ? " project" : ""}`} aria-hidden>
                {w.tier}
              </span>
              <div className="tier-text">
                <span className="tier-description" title={w.description}>
                  <span className="sr-only">{w.tier}: </span>
                  {w.description}
                </span>
                <span className="muted tier-meta">
                  {w.source === "project" ? (
                    <>
                      {t("setup.workflows.sourceProject")} ·{" "}
                      <code title={`sha256 ${w.hash}`}>
                        {w.file} · {w.hash}
                      </code>
                    </>
                  ) : (
                    <>
                      {t("setup.workflows.sourceApp")} ·{" "}
                      {t("setup.workflows.idVersion", { id: w.id, version: w.version })}
                    </>
                  )}
                </span>
              </div>
              <button type="button" className="ghost small" onClick={() => setEditing(w.tier)}>
                <Pencil size={13} aria-hidden />
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
      <TaskDefaultsCard cwd={cwd} workspaces={workspaces} confirm={confirm} />
    </div>
  );
}

/**
 * How this workspace's tasks run unless a task chooses (owner request, 2026-11-10): its own values over the app's
 * (Settings), field by field. Saved as soon as one changes, in `.agentchainer/defaults.json`, out of git. "Apply to
 * all workspaces" copies this workspace's own values to every workspace the app knows.
 */
function TaskDefaultsCard({ cwd, workspaces, confirm }: { cwd: string; workspaces: string[]; confirm: Confirm }) {
  const [clis, setClis] = useState<AgentClis | null>(null);
  const [view, setView] = useState<TaskDefaultsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    void request("agents.available", {}).then(setClis, () => setClis(null));
    void request("workspace.defaults", { cwd }).then(setView, (err: unknown) => setError(message(err)));
  }, [cwd]);
  if (!view) return error ? <p className="warn">{error}</p> : null;
  const save = async (next: TaskDefaults) => {
    setView({ ...view, workspace: next });
    setNotice(null);
    try {
      setView(await request("workspace.setDefaults", { cwd, defaults: next }));
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  };
  const others = workspaces.filter((w) => folderKey(w) !== folderKey(cwd));
  const applyToAll = async () => {
    const ok = await confirm({
      title: t("setup.workflows.applyAllTitle"),
      body: <p>{t("setup.workflows.applyAllBody", { count: others.length })}</p>,
      confirmLabel: t("setup.workflows.applyAll"),
    });
    if (!ok) return;
    let done = 0;
    const failed: string[] = [];
    for (const dir of others) {
      try {
        await request("workspace.setDefaults", { cwd: dir, defaults: view.workspace });
        done++;
      } catch {
        failed.push(folderName(dir));
      }
    }
    setNotice(
      failed.length
        ? t("setup.workflows.appliedSome", { count: done, failed: failed.join(", ") })
        : t("setup.workflows.applied", { count: done }),
    );
  };
  const own = Object.keys(view.workspace).length > 0;
  return (
    <section className="card deploy-card">
      <div className="card-title">
        <Bot size={16} aria-hidden />
        <h2>{t("setup.workflows.defaultsTitle")}</h2>
        <span className="grow" />
        {own && (
          <button type="button" className="ghost small" onClick={() => void save({})}>
            {t("setup.workflows.useApp")}
          </button>
        )}
        {others.length > 0 && (
          <button type="button" className="secondary small" onClick={() => void applyToAll()}>
            {t("setup.workflows.applyAll")}
          </button>
        )}
      </div>
      <p className="muted">{t("setup.workflows.defaultsHelp")}</p>
      <TaskDefaultsFields value={view.workspace} onChange={(next) => void save(next)} clis={clis} fallback={view.app} />
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
      {error && <p className="warn">{error}</p>}
    </section>
  );
}
