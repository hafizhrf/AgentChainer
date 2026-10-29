import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState } from "react";
import { Modal } from "./Dialog.tsx";
import { Markdown } from "./Markdown.tsx";

const RELEASES = "https://github.com/hafizhrf/AgentChainer/releases";

type Step =
  | { step: "checking" }
  | { step: "not-set-up" }
  | { step: "current" }
  | { step: "available"; update: Update }
  | { step: "downloading"; received: number; total: number | null }
  | { step: "installing" }
  | { step: "failed"; message: string; restart: boolean };

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Checks for a new version when opened and installs one only when asked (R1-04): nothing downloads in the background.
 * Updates are signed, and the updater refuses one that doesn't match the public key built into the app.
 */
export function UpdateDialog({ appVersion, onClose }: { appVersion: string | null; onClose: () => void }) {
  const [state, setState] = useState<Step>({ step: "checking" });
  const found = useRef<Update | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      if (!(await invoke<boolean>("updater_ready"))) {
        if (live) setState({ step: "not-set-up" });
        return;
      }
      const update = await check({ timeout: 30_000 });
      if (!live) {
        void update?.close();
        return;
      }
      found.current = update;
      setState(update ? { step: "available", update } : { step: "current" });
    })().catch((err: unknown) => {
      if (live) setState({ step: "failed", message: `Couldn't check for updates: ${describe(err)}`, restart: false });
    });
    return () => {
      live = false;
      void found.current?.close().catch(() => undefined);
    };
  }, []);

  async function install(update: Update) {
    found.current = null;
    setState({ step: "downloading", received: 0, total: null });
    try {
      await update.download((e) => {
        if (e.event === "Started")
          setState((s) => (s.step === "downloading" ? { ...s, total: e.data.contentLength ?? null } : s));
        if (e.event === "Progress")
          setState((s) => (s.step === "downloading" ? { ...s, received: s.received + e.data.chunkLength } : s));
      });
    } catch (err) {
      void update.close().catch(() => undefined);
      setState({ step: "failed", message: `The download failed: ${describe(err)}`, restart: false });
      return;
    }
    setState({ step: "installing" });
    try {
      await invoke("update_prepare");
      // On Windows the installer takes over here and the app exits; macOS and Linux restart into the new version.
      await update.install();
      await relaunch();
    } catch (err) {
      setState({
        step: "failed",
        message: `The update couldn't be installed: ${describe(err)}. Restart AgentChainer to continue.`,
        restart: true,
      });
    }
  }

  const busy = state.step === "downloading" || state.step === "installing";
  const failedHard = state.step === "failed" && state.restart;
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Check for updates"
      dismissible={!busy && !failedHard}
      actions={
        state.step === "available" ? (
          <>
            <button type="button" className="secondary" onClick={onClose}>
              Later
            </button>
            <button type="button" onClick={() => void install(state.update)}>
              Install and restart
            </button>
          </>
        ) : failedHard ? (
          <button type="button" onClick={() => void relaunch()}>
            Restart AgentChainer
          </button>
        ) : busy ? null : (
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      <div className="update">
        {state.step === "checking" && <p>Checking for a new version…</p>}
        {state.step === "not-set-up" && (
          <>
            <p>Updates aren't set up in this build.</p>
            <p className="field-help">
              Development builds, and builds made without the release key, can't check for updates. New versions are on
              the{" "}
              <button type="button" className="link" onClick={() => void openUrl(RELEASES)}>
                releases page
              </button>
              .
            </p>
          </>
        )}
        {state.step === "current" && <p>AgentChainer {appVersion ?? ""} is the newest version.</p>}
        {state.step === "available" && (
          <>
            <p>
              Version {state.update.version} is available. You have {state.update.currentVersion}.
            </p>
            {state.update.body?.trim() && (
              <div className="update-notes">
                <Markdown text={state.update.body} />
              </div>
            )}
            <p className="field-help">
              Installing stops running agents and closes terminals. Resume your sessions from the sidebar after the
              restart.
            </p>
          </>
        )}
        {state.step === "downloading" && (
          <>
            <p>
              Downloading…{" "}
              {state.total ? `${mb(state.received)} of ${mb(state.total)}` : state.received ? mb(state.received) : ""}
            </p>
            <progress
              className="update-progress"
              max={state.total ?? undefined}
              value={state.total ? state.received : undefined}
            />
          </>
        )}
        {state.step === "installing" && <p>Installing… AgentChainer restarts when it's done.</p>}
        {state.step === "failed" && <p className="dialog-error">{state.message}</p>}
      </div>
    </Modal>
  );
}
