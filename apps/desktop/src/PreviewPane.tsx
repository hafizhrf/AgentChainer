import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Globe, RefreshCw, ServerOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "./i18n/index.ts";
import { localUrl } from "./preview.ts";
import { request } from "./sidecar.ts";
import { IconButton } from "./ui/IconButton.tsx";
import { EmptyState } from "./ui/Section.tsx";

/** How often a shown preview checks that its server still answers. */
const PROBE_MS = 3000;

/**
 * The app being built, in the right panel (UX-22). Only this machine's addresses open: the page runs in a sandboxed
 * frame of its own origin, which Tauri's capabilities give no IPC (they're for the app's own origin), and the sandbox
 * leaves it no top navigation or popups. While it shows, the server is checked every few seconds; when it stops, the
 * pane says so, and reloads once it answers again.
 */
export function PreviewPane({
  url,
  detected,
  visible,
  onUrlChange,
}: {
  url: string | null;
  /** Addresses the chat's commands printed, the latest first. */
  detected: readonly string[];
  /** The tab is showing: only then is the server checked. */
  visible: boolean;
  onUrlChange: (url: string) => void;
}) {
  const [draft, setDraft] = useState(url ?? "");
  const [error, setError] = useState<string | null>(null);
  const [up, setUp] = useState<boolean | null>(null);
  const [reloads, setReloads] = useState(0);
  const wasUp = useRef<boolean | null>(null);

  useEffect(() => {
    setDraft(url ?? "");
    setError(null);
    setUp(null);
    wasUp.current = null;
  }, [url]);

  // Is the server still there? A stop shows a notice; coming back reloads the page.
  useEffect(() => {
    if (!url || !visible) return;
    let current = true;
    const check = () =>
      request("preview.probe", { url })
        .then(({ up: now }) => {
          if (!current) return;
          if (now && wasUp.current === false) setReloads((n) => n + 1);
          wasUp.current = now;
          setUp(now);
        })
        .catch(() => undefined);
    void check();
    const timer = setInterval(check, PROBE_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [url, visible]);

  function go(address: string) {
    const next = localUrl(address.includes("://") ? address : `http://${address}`);
    if (!next) {
      setError(t("panel.preview.notLocal"));
      return;
    }
    setError(null);
    if (next === url) setReloads((n) => n + 1);
    else onUrlChange(next);
  }

  const others = detected.filter((d) => d !== url);
  return (
    <div className="preview-pane">
      <form
        className="preview-bar"
        onSubmit={(e) => {
          e.preventDefault();
          go(draft);
        }}
      >
        <IconButton label={t("panel.preview.reload")} onClick={() => setReloads((n) => n + 1)} disabled={!url}>
          <RefreshCw size={14} />
        </IconButton>
        <label className="preview-address">
          <Globe size={13} aria-hidden />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("panel.preview.placeholder")}
            aria-label={t("panel.preview.address")}
            spellCheck={false}
          />
        </label>
        <IconButton
          label={t("panel.preview.openInBrowser")}
          onClick={() => url && void openUrl(url).catch((err: unknown) => setError(String(err)))}
          disabled={!url}
        >
          <ExternalLink size={14} />
        </IconButton>
      </form>
      {error && <p className="warn">{error}</p>}
      {others.length > 0 && (
        <div className="preview-found">
          <span className="muted">{t("panel.preview.found")}</span>
          {others.slice(0, 3).map((d) => (
            <button key={d} type="button" className="chip" onClick={() => onUrlChange(d)}>
              {d.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            </button>
          ))}
        </div>
      )}
      {!url ? (
        <EmptyState icon={<Globe size={14} />}>{t("panel.preview.empty")}</EmptyState>
      ) : (
        <div className="preview-stage">
          {up === false && (
            <div className="preview-down" role="status">
              <ServerOff size={18} aria-hidden />
              <p>{t("panel.preview.down", { url })}</p>
            </div>
          )}
          <iframe
            key={`${url}#${reloads}`}
            src={url}
            title={t("panel.preview.frameTitle", { url })}
            // Scripts and forms for the app being built; no top navigation, popups or downloads into the app.
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
            referrerPolicy="no-referrer"
            hidden={up === false}
          />
        </div>
      )}
    </div>
  );
}
