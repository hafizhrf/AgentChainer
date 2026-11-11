import type { Methods } from "@agentchainer/protocol";
import { CircleAlert, CircleCheck, Loader2, Save, ShieldCheck, Wand2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { count, fileSize } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
import { request } from "../sidecar.ts";
import { Field } from "../ui/Field.tsx";

type Config = Methods["worktree.config"]["result"];
type Kind = "setup" | "run";

/** What "Use suggested" puts in `.worktreeinclude`: the usual local env files. Nothing is saved until Save. */
export const SUGGESTED_INCLUDE = ".env\n.env.local\n.env.*.local\n";

/**
 * Workspace settings → Worktrees (CP-04): what a task's new worktree gets besides the tracked files. The gitignored
 * files `.worktreeinclude` names are copied from here; the setup script runs in it instead of the detected install
 * command, and Run app starts the run script. Scripts are committed with the project, so each one runs only once
 * it's allowed on this computer.
 */
export function Worktrees({ cwd, confirm, onChanged }: { cwd: string; confirm: Confirm; onChanged: () => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [include, setInclude] = useState("");
  const [setup, setSetup] = useState("");
  const [run, setRun] = useState("");
  const [listed, setListed] = useState<Pick<Config, "files" | "bytes" | "capped"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const c = await request("worktree.config", { cwd });
      setConfig(c);
      setInclude(c.include.text);
      setSetup(c.setup ?? "");
      setRun(c.run ?? "");
      setListed(c);
    } catch (err) {
      setError(String(err));
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  // What the draft would copy, a moment after typing stops.
  useEffect(() => {
    if (!config || include === config.include.text) return;
    const timer = setTimeout(() => {
      request("worktree.config", { cwd, include }).then(
        (c) => setListed(c),
        (err: unknown) => setError(String(err)),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [cwd, include, config]);

  if (!config) {
    return (
      <div className="setup-scroll">
        {error ? <p className="warn">{error}</p> : <p className="muted">{t("setup.worktrees.loading")}</p>}
      </div>
    );
  }

  const dirty = include !== config.include.text || setup !== (config.setup ?? "") || run !== (config.run ?? "");

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await request("worktree.save", { cwd, include, setup, run });
      setNotice(r.runId ? t("setup.worktrees.saved") : t("setup.worktrees.unchanged"));
      onChanged();
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function allow(kind: Kind, command: string) {
    const ok = await confirm({
      title: kind === "setup" ? t("setup.worktrees.allowSetupTitle") : t("setup.worktrees.allowRunTitle"),
      body: (
        <>
          <p>{t("setup.worktrees.allowBody")}</p>
          <pre className="plugin-raw">{command}</pre>
        </>
      ),
      confirmLabel: t("setup.worktrees.allow"),
      danger: true,
    });
    if (!ok) return;
    try {
      await request("worktree.allow", { cwd, kind, command });
      await load();
    } catch (err) {
      setError(String(err));
    }
  }

  const script = (kind: Kind) => {
    const saved = kind === "setup" ? config.setup : config.run;
    const draft = kind === "setup" ? setup : run;
    const allowed = kind === "setup" ? config.setupAllowed : config.runAllowed;
    const detected = kind === "setup" ? config.detected.install : config.detected.dev;
    return (
      <Field
        label={kind === "setup" ? t("setup.worktrees.setupLabel") : t("setup.worktrees.runLabel")}
        help={
          <>
            {kind === "setup" ? t("setup.worktrees.setupHelp") : t("setup.worktrees.runHelp")}{" "}
            {saved && draft === saved && (
              <span className={`worktree-allowed${allowed ? " ok" : ""}`}>
                {allowed ? <CircleCheck size={13} /> : <CircleAlert size={13} />}
                {allowed ? t("setup.worktrees.allowed") : t("setup.worktrees.notAllowed")}
              </span>
            )}
          </>
        }
      >
        <div className="worktree-script">
          <input
            className="worktree-script-input"
            value={draft}
            spellCheck={false}
            onChange={(e) => (kind === "setup" ? setSetup(e.target.value) : setRun(e.target.value))}
            placeholder={
              detected ? t("setup.worktrees.emptyUses", { command: detected }) : t("setup.worktrees.emptyNothing")
            }
          />
          {saved && draft === saved && !allowed && (
            <button type="button" className="secondary small" onClick={() => void allow(kind, saved)}>
              <ShieldCheck size={14} />
              {t("setup.worktrees.allowEllipsis")}
            </button>
          )}
        </div>
      </Field>
    );
  };

  return (
    <div className="setup-scroll worktrees">
      <p className="field-help worktrees-intro">{t("setup.worktrees.intro")}</p>
      {config.problem && <p className="warn">{config.problem}</p>}
      {error && <p className="warn">{error}</p>}
      {notice && (
        <p className="banner">
          <span className="grow">{notice}</span>
          <button type="button" className="ghost small" onClick={() => setNotice(null)}>
            {t("setup.worktrees.dismiss")}
          </button>
        </p>
      )}

      <section className="card worktree-card" aria-labelledby="worktree-files">
        <div className="card-title">
          <h2 id="worktree-files">{t("setup.worktrees.filesTitle")}</h2>
          <span className="grow" />
          {!include.trim() && (
            <button type="button" className="ghost small" onClick={() => setInclude(SUGGESTED_INCLUDE)}>
              <Wand2 size={14} />
              {t("setup.worktrees.useSuggested")}
            </button>
          )}
        </div>
        <p className="field-help">
          <Rich
            k="setup.worktrees.filesHelp"
            params={{ file: ".worktreeinclude" }}
            tags={{ code: (s) => <code>{s}</code> }}
          />
        </p>
        <textarea
          className="worktree-include"
          rows={5}
          spellCheck={false}
          aria-label={t("setup.worktrees.includeLabel")}
          value={include}
          placeholder={SUGGESTED_INCLUDE}
          onChange={(e) => setInclude(e.target.value)}
        />
        {listed && include.trim() && (
          <div className="worktree-files">
            <p className="muted">
              {listed.files.length
                ? t("setup.worktrees.wouldCopy", { count: listed.files.length, size: fileSize(listed.bytes) })
                : t("setup.worktrees.wouldCopyNone")}
            </p>
            {listed.files.length > 0 && (
              <ul className="plain-list worktree-file-list">
                {listed.files.slice(0, 20).map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code> <span className="muted">{fileSize(f.bytes)}</span>
                  </li>
                ))}
                {listed.files.length > 20 && (
                  <li className="muted">{t("setup.worktrees.andMore", { n: count(listed.files.length - 20) })}</li>
                )}
              </ul>
            )}
            {listed.capped && <p className="warn">{t("setup.worktrees.capped")}</p>}
            {listed.files.length > 0 && <p className="callout">{t("setup.worktrees.agentsRead")}</p>}
          </div>
        )}
      </section>

      <section className="card worktree-card" aria-labelledby="worktree-scripts">
        <div className="card-title">
          <h2 id="worktree-scripts">{t("setup.worktrees.scriptsTitle")}</h2>
        </div>
        <p className="field-help">
          <Rich
            k="setup.worktrees.scriptsHelp"
            params={{ file: ".agentchainer/worktree.json" }}
            tags={{ code: (s) => <code>{s}</code> }}
          />
        </p>
        {script("setup")}
        {script("run")}
      </section>

      <div className="worktree-actions">
        <button type="button" className="primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
          {t("setup.worktrees.save")}
        </button>
        <span className="muted">{t("setup.worktrees.saveNote")}</span>
      </div>
    </div>
  );
}
