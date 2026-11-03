import { folderProblems } from "@agentchainer/protocol";
import { FolderPlus, X } from "lucide-react";
import { useState } from "react";
import { Modal } from "./Dialog.tsx";
import { pickFolder } from "./HomeView.tsx";
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
        <h2 id="home-workspaces">Workspaces</h2>
        <span className="muted">Several folders in one session, e.g. an app and its API</span>
        <span className="grow" />
        <button type="button" className="secondary small" onClick={onNew}>
          <FolderPlus size={14} />
          New workspace…
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
              {selected?.id === w.id && <span className="chip on">Selected</span>}
              <ActionMenu
                label={`${w.name} actions`}
                items={[
                  { label: "Edit…", onSelect: () => onEdit(w) },
                  { label: "Remove", onSelect: () => onDelete(w), danger: true },
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
      title={initial ? "Edit workspace" : "New workspace"}
      description="A named set of folders, e.g. an app and its API: a session works across all of them."
      size="lg"
      actions={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
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
            Save workspace
          </button>
        </>
      }
    >
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Shop" />
      </Field>
      <div className="ws-folders">
        <span className="field-label">Folders</span>
        {folders.length === 0 && <p className="muted">Add the primary folder first: sessions start there.</p>}
        <ul>
          {folders.map((dir, i) => (
            <li key={dir}>
              <span className={i === 0 ? "chip on" : "chip"}>{i === 0 ? "Primary" : "Also"}</span>
              <span className="ws-folder-name">{folderName(dir)}</span>
              <span className="muted ws-folder-path" title={dir}>
                {dir}
              </span>
              <button
                type="button"
                className="ghost icon tiny"
                aria-label={`Remove ${folderName(dir)}`}
                onClick={() => setFolders((all) => all.filter((_, j) => j !== i))}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="secondary small" onClick={() => void add()}>
          <FolderPlus size={14} />
          {folders.length ? "Add a folder…" : "Choose the primary folder…"}
        </button>
      </div>
      {problems.length > 0 && (
        <ul className="warn ws-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <p className="field-help">
        Claude can read and change every folder listed here, with the same approvals and guard as in one folder. Only
        the primary folder's CLAUDE.md, project settings, hooks and skills apply: the CLI doesn't load them from the
        others (checked on CLI 2.1.314).
      </p>
    </Modal>
  );
}
