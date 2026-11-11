import type { Task } from "@agentchainer/protocol";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Eye, Loader2, Play, Square } from "lucide-react";
import { lazy, Suspense, useCallback, useRef, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { t } from "../i18n/index.ts";
import { PreviewPane } from "../PreviewPane.tsx";
import { localUrls } from "../preview.ts";
import { request } from "../sidecar.ts";

const TerminalPanel = lazy(() => import("../TerminalPanel.tsx"));

/** How much of the terminal's latest output is searched for the app's address: one may span two chunks. */
const KEEP = 4000;

/**
 * Run app (CP-04): starts the project's run script (else its detected dev command) in the task's worktree, in a
 * terminal the person sees and stops. A script the person hasn't allowed on this computer is shown first. The local
 * addresses it prints open in the Preview or the browser.
 */
export function RunApp({ task, cwd, confirm }: { task: Task; cwd: string; confirm: Confirm }) {
  const [running, setRunning] = useState<{ command: string; dir: string; key: number } | null>(null);
  const [urls, setUrls] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const output = useRef("");

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await request("task.runCommand", { cwd, id: task.id });
      if (!r.allowed) {
        const ok = await confirm({
          title: t("tasks.runApp.allowTitle"),
          body: (
            <>
              <p>{r.script ? t("tasks.runApp.allowScript") : t("tasks.runApp.allowDetected")}</p>
              <pre className="plugin-raw">{r.command}</pre>
            </>
          ),
          confirmLabel: t("tasks.runApp.allowAndRun"),
          danger: true,
        });
        if (!ok) return;
        await request("worktree.allow", { cwd, kind: "run", command: r.command });
      }
      output.current = "";
      setUrls([]);
      setPreview(null);
      setRunning({ command: r.command, dir: r.dir, key: Date.now() });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const onOutput = useCallback((text: string) => {
    output.current = (output.current + text).slice(-KEEP);
    const found = localUrls(output.current);
    if (found.length) setUrls((was) => [...was, ...found.filter((u) => !was.includes(u))]);
  }, []);

  return (
    <section className="card run-app" aria-labelledby="run-app-title">
      <div className="card-title">
        <h2 id="run-app-title">{t("tasks.runApp.title")}</h2>
        <span className="grow" />
        {running ? (
          <button type="button" className="secondary small" onClick={() => setRunning(null)}>
            <Square size={13} />
            {t("tasks.runApp.stop")}
          </button>
        ) : (
          <button type="button" className="secondary small" disabled={busy} onClick={() => void start()}>
            {busy ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
            {t("tasks.runApp.run")}
          </button>
        )}
      </div>
      {!running && <p className="field-help">{t("tasks.runApp.help", { branch: task.worktree?.branch ?? "" })}</p>}
      {error && <p className="warn">{error}</p>}
      {running && (
        <>
          <p className="field-help">
            {t("tasks.runApp.running", { branch: task.worktree?.branch ?? "" })} <code>{running.command}</code>
          </p>
          <div className="run-app-terminal">
            <Suspense fallback={<p className="muted">{t("tasks.runApp.starting")}</p>}>
              <TerminalPanel key={running.key} cwd={running.dir} command={running.command} onOutput={onOutput} />
            </Suspense>
          </div>
          {urls.length > 0 && (
            <div className="run-app-urls">
              {urls.map((u) => (
                <span key={u} className="run-app-url">
                  <code>{u}</code>
                  <button type="button" className="ghost small" onClick={() => setPreview(preview === u ? null : u)}>
                    <Eye size={13} />
                    {preview === u ? t("tasks.runApp.hidePreview") : t("tasks.runApp.preview")}
                  </button>
                  <button type="button" className="ghost small" onClick={() => void openUrl(u)}>
                    <ExternalLink size={13} />
                    {t("tasks.runApp.openBrowser")}
                  </button>
                </span>
              ))}
            </div>
          )}
          {preview && (
            <div className="run-app-preview">
              <PreviewPane url={preview} detected={urls} visible onUrlChange={setPreview} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
