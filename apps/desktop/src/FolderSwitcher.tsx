import { Folder } from "lucide-react";
import { t } from "./i18n/index.ts";
import { folderName } from "./tabs.ts";

/**
 * Which of a multi-folder workspace's folders a panel shows (M8-01, design §5.4): the right panel's changes, files and
 * git, and Workspace settings. Nothing with a single folder.
 */
export function FolderSwitcher({
  folders,
  current,
  onChange,
}: {
  /** The primary folder first. */
  folders: string[];
  current: string;
  onChange: (dir: string) => void;
}) {
  if (folders.length < 2) return null;
  return (
    <fieldset className="folder-switcher" aria-label={t("panel.folders.label")}>
      {folders.map((dir, i) => (
        <button
          key={dir}
          type="button"
          aria-pressed={dir === current}
          className={dir === current ? "chip on" : "chip"}
          title={i === 0 ? t("panel.folders.primary", { dir }) : dir}
          onClick={() => onChange(dir)}
        >
          <Folder size={12} aria-hidden />
          {folderName(dir)}
        </button>
      ))}
    </fieldset>
  );
}
