import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useRef, useState } from "react";
import { Modal } from "./Dialog.tsx";
import { megabytes as mb } from "./i18n/format.ts";
import { t } from "./i18n/index.ts";
import { Rich } from "./i18n/Rich.tsx";
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
      if (live)
        setState({ step: "failed", message: t("home.update.checkFailed", { error: describe(err) }), restart: false });
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
      setState({ step: "failed", message: t("home.update.downloadFailed", { error: describe(err) }), restart: false });
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
        message: t("home.update.installFailed", { error: describe(err) }),
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
      title={t("home.update.title")}
      dismissible={!busy && !failedHard}
      actions={
        state.step === "available" ? (
          <>
            <button type="button" className="secondary" onClick={onClose}>
              {t("home.update.later")}
            </button>
            <button type="button" onClick={() => void install(state.update)}>
              {t("home.update.install")}
            </button>
          </>
        ) : failedHard ? (
          <button type="button" onClick={() => void relaunch()}>
            {t("home.update.restart")}
          </button>
        ) : busy ? null : (
          <button type="button" className="secondary" onClick={onClose}>
            {t("shell.dialog.close")}
          </button>
        )
      }
    >
      <div className="update">
        {state.step === "checking" && <p>{t("home.update.checking")}</p>}
        {state.step === "not-set-up" && (
          <>
            <p>{t("home.update.notSetUp")}</p>
            <p className="field-help">
              <Rich
                k="home.update.notSetUpHelp"
                tags={{
                  link: (s) => (
                    <button type="button" className="link" onClick={() => void openUrl(RELEASES)}>
                      {s}
                    </button>
                  ),
                }}
              />
            </p>
          </>
        )}
        {state.step === "current" && <p>{t("home.update.current", { version: appVersion ?? "" })}</p>}
        {state.step === "available" && (
          <>
            <p>
              {t("home.update.available", {
                version: state.update.version,
                current: state.update.currentVersion,
              })}
            </p>
            {state.update.body?.trim() && (
              <div className="update-notes">
                <Markdown text={state.update.body} />
              </div>
            )}
            <p className="field-help">{t("home.update.installHelp")}</p>
          </>
        )}
        {state.step === "downloading" && (
          <>
            <p>
              {t("home.update.downloading")}{" "}
              {state.total
                ? t("home.update.progress", { received: mb(state.received), total: mb(state.total) })
                : state.received
                  ? mb(state.received)
                  : ""}
            </p>
            <progress
              className="update-progress"
              max={state.total ?? undefined}
              value={state.total ? state.received : undefined}
            />
          </>
        )}
        {state.step === "installing" && <p>{t("home.update.installing")}</p>}
        {state.step === "failed" && <p className="dialog-error">{state.message}</p>}
      </div>
    </Modal>
  );
}
