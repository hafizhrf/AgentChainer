import type { WorkspaceImage } from "@agentchainer/protocol";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { fileSize } from "./i18n/format.ts";
import { t } from "./i18n/index.ts";
import { request } from "./sidecar.ts";

/**
 * An image in the workspace, shown as a picture rather than as text (UX-21): fit to the panel, on a checkerboard so
 * transparency shows, with its pixel size and file size. An SVG goes in an `<img>`, so its scripts never run. Re-reads
 * the file whenever `version` changes (the workspace listing refreshed).
 */
export default function ImageView({
  cwd,
  path,
  version,
  status,
  onClose,
  onOpenInEditor,
}: {
  cwd: string;
  path: string;
  version: unknown;
  status?: string | undefined;
  onClose: () => void;
  onOpenInEditor: () => void;
}) {
  const [image, setImage] = useState<WorkspaceImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pixels, setPixels] = useState<{ w: number; h: number } | null>(null);
  const [broken, setBroken] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the refresh trigger.
  useEffect(() => {
    let current = true;
    setPixels(null);
    setBroken(false);
    request("workspace.image", { cwd, path })
      .then((img) => {
        if (!current) return;
        setImage(img);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!current) return;
        setImage(null);
        setError(String(err));
      });
    return () => {
      current = false;
    };
  }, [cwd, path, version]);

  const details = [
    pixels ? t("panel.image.pixels", { w: pixels.w, h: pixels.h }) : null,
    image ? fileSize(image.bytes) : null,
  ].filter(Boolean);

  return (
    <div className="diff-view image-view">
      <header className="diff-header">
        <button type="button" className="ghost small" onClick={onClose} aria-label={t("panel.diff.backLabel")}>
          <ArrowLeft size={14} />
          {t("panel.diff.back")}
        </button>
        <code className="grow diff-path" title={path}>
          {path}
        </code>
        {status && <span className="badge">{status}</span>}
      </header>
      <div className="diff-actions">
        <button type="button" className="ghost small" onClick={onOpenInEditor}>
          <ExternalLink size={14} />
          {t("panel.diff.openInEditor")}
        </button>
        {details.length > 0 && <span className="muted image-details">{details.join(" · ")}</span>}
      </div>
      {error && <p className="warn">{error}</p>}
      {image?.tooLarge && <p className="muted">{t("panel.image.tooLarge", { size: fileSize(image.bytes) })}</p>}
      {broken && <p className="warn">{t("panel.image.broken")}</p>}
      {image?.data && !broken && (
        <div className="image-stage">
          <img
            src={`data:${image.mediaType};base64,${image.data}`}
            alt={path}
            onLoad={(e) => setPixels({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => setBroken(true)}
          />
        </div>
      )}
    </div>
  );
}
