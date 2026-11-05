import { folderProblems } from "@agentchainer/protocol";
import { FolderPlus, X } from "lucide-react";
import { useState } from "react";
import { Modal } from "./Dialog.tsx";
import { pickFolder } from "./HomeView.tsx";
import { t } from "./i18n/index.ts";
import type { WorkspaceDef } from "./settings.ts";
import { folderName } from "./tabs.ts";
import { ActionMenu } from "./ui/ActionMenu.tsx";
import { Field } from "./ui/Field.tsx";

/**
 * Home's named workspaces (M8-01): picking one makes its primary folder Home's folder and New reach the others too.
 */
export function WorkspacesCard({
  workspaces,
  selected,
  onPick,
  onNew,
  onEdit,
  onDelete,
}: {
  workspaces: WorkspaceDef[];
  selected: WorkspaceDef | null;
  onPick: (def: WorkspaceDef) => void;
  onNew: () => void;
  onEdit: (def: WorkspaceDef) => void;
  onDelete: (def: WorkspaceDef) => void;
}) {
  return (
    <section className="card" aria-labelledby="home-workspaces">
      <div className="card-title">
        <h2 id="home-workspaces">{t("shell.workspacesCard.title")}</h2>
        <span className="muted">{t("shell.workspacesCard.hint")}</span>
        <span className="grow" />
        <button type="button" className="secondary small" onClick={onNew}>
          <FolderPlus size={14} />
          {t("shell.workspacesCard.new")}
        </button>
      </div>
      {workspaces.length > 0 && (
        <ul className="task-list">
          {workspaces.map((w) => (
            <li key={w.id} className="task-row">
              <button
                type="button"
                className="task-row-main"
                aria-pressed={selected?.id === w.id}
                onClick={() => onPick(w)}
              >
                <span className="task-row-title">{w.name}</span>
                <span className="muted">{[w.primary, ...w.folders].map(folderName).join(" · ")}</span>
              </button>
              {selected?.id === w.id && <span className="chip on">{t("shell.workspacesCard.selected")}</span>}
              <ActionMenu
                label={t("shell.workspacesCard.actions", { name: w.name })}
                items={[
                  { label: t("shell.workspacesCard.edit"), onSelect: () => onEdit(w) },
                  { label: t("shell.workspacesCard.remove"), onSelect: () => onDelete(w), danger: true },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * New workspace, or editing one (M8-01, docs/design/workspaces-and-fleet.md §5.1): a name, the primary folder (where
 * sessions start and whose CLAUDE.md, settings and hooks apply) and the other folders Claude may read and change. The
 * same rules as the sidecar's refuse the home folder, a drive, repeats and nested folders.
 */
export function WorkspaceDialog({
  initial,
  homeDir,
  onSave,
  onClose,
}: {
  initial: WorkspaceDef | null;
  homeDir: string | null;
  onSave: (def: WorkspaceDef) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [folders, setFolders] = useState<string[]>(initial ? [initial.primary, ...initial.folders] : []);
  const problems = folders.length ? folderProblems(folders, homeDir) : [];
  const ready = name.trim() !== "" && folders.length >= 2 && problems.length === 0;

  async function add() {
    const dir = await pickFolder();
    if (dir) setFolders((all) => [...all, dir]);
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={initial ? t("shell.workspaceDialog.editTitle") : t("shell.workspaceDialog.newTitle")}
      description={t("shell.workspaceDialog.description")}
      size="lg"
      actions={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            {t("shell.dialog.cancel")}
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() =>
              onSave({
                id: initial?.id ?? crypto.randomUUID(),
                name: name.trim(),
                primary: folders[0] ?? "",
                folders: folders.slice(1),
              })
            }
          >
            {t("shell.workspaceDialog.save")}
          </button>
        </>
      }
    >
      <Field label={t("shell.workspaceDialog.name")}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("shell.workspaceDialog.namePlaceholder")}
        />
      </Field>
      <div className="ws-folders">
        <span className="field-label">{t("shell.workspaceDialog.folders")}</span>
        {folders.length === 0 && <p className="muted">{t("shell.workspaceDialog.empty")}</p>}
        <ul>
          {folders.map((dir, i) => (
            <li key={dir}>
              <span className={i === 0 ? "chip on" : "chip"}>
                {i === 0 ? t("shell.workspaceDialog.primary") : t("shell.workspaceDialog.also")}
              </span>
              <span className="ws-folder-name">{folderName(dir)}</span>
              <span className="muted ws-folder-path" title={dir}>
                {dir}
              </span>
              <button
                type="button"
                className="ghost icon tiny"
                aria-label={t("shell.workspaceDialog.removeFolder", { name: folderName(dir) })}
                onClick={() => setFolders((all) => all.filter((_, j) => j !== i))}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="secondary small" onClick={() => void add()}>
          <FolderPlus size={14} />
          {folders.length ? t("shell.workspaceDialog.addFolder") : t("shell.workspaceDialog.choosePrimary")}
        </button>
      </div>
      {problems.length > 0 && (
        <ul className="warn ws-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <p className="field-help">{t("shell.workspaceDialog.help")}</p>
    </Modal>
  );
}
