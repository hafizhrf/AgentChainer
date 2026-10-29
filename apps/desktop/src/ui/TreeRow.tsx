import type { FileStatus } from "@agentchainer/protocol";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode, Ref } from "react";
import { STATUS_LETTER, splitPath } from "../files.ts";
import { FileIcon } from "./FileIcon.tsx";

/**
 * One row of a file list or tree (UX-03): indent, chevron, icon, name tinted by git status, a muted detail, actions
 * that show on hover, and the status letter. Used by the Files, Changes and Git views.
 */
export function TreeRow({
  depth = 0,
  chevron,
  icon,
  name,
  detail,
  status,
  dot = false,
  selected = false,
  dimmed = false,
  title,
  actions,
  onClick,
  buttonRef,
  buttonProps,
}: {
  depth?: number;
  /** Folders: the expand chevron. Rows without one keep the space only inside trees. */
  chevron?: ReactNode;
  icon: ReactNode;
  name: string;
  detail?: string;
  status?: FileStatus | undefined;
  /** A folder with changes below it. */
  dot?: boolean;
  selected?: boolean;
  dimmed?: boolean;
  title?: string;
  actions?: ReactNode;
  onClick?: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement> & Record<`aria-${string}`, unknown>;
}) {
  return (
    <div
      className={`tree-item${selected ? " selected" : ""}${dimmed ? " dimmed" : ""}`}
      style={{ "--depth": depth } as CSSProperties}
    >
      <button
        type="button"
        ref={buttonRef}
        className="tree-main"
        title={title}
        disabled={!onClick}
        onClick={onClick}
        {...buttonProps}
      >
        {chevron !== undefined && <span className="tree-chevron">{chevron}</span>}
        {icon}
        <span className={`tree-name${status ? ` status-${status}` : ""}`}>{name}</span>
        {detail && <span className="tree-detail">{detail}</span>}
      </button>
      {actions && <span className="tree-actions">{actions}</span>}
      {dot && <span className="tree-dot" aria-hidden />}
      {status && (
        <span className={`tree-status status-${status}`} title={status}>
          {STATUS_LETTER[status]}
        </span>
      )}
    </div>
  );
}

/** A changed or edited file in a flat list: its name, with the folder it's in muted next to it. */
export function FileRow({
  path,
  status,
  selected,
  actions,
  onSelect,
  outside = false,
}: {
  path: string;
  status?: FileStatus | undefined;
  selected: boolean;
  actions?: ReactNode;
  onSelect?: () => void;
  /** Outside the workspace: shown, but there's no diff to open. */
  outside?: boolean;
}) {
  const { dir, name } = splitPath(path);
  return (
    <TreeRow
      icon={<FileIcon path={name} />}
      name={name}
      detail={dir}
      status={status}
      selected={selected}
      dimmed={outside}
      title={outside ? `${path} (outside the workspace)` : path}
      actions={actions}
      {...(onSelect && !outside ? { onClick: onSelect } : {})}
    />
  );
}
