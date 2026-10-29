import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { usePersistentFlag } from "./layoutStorage.ts";

/**
 * A collapsible group with a header (UX-03), like the sections of VS Code's source control view or JetBrains'
 * changelists. With an `id`, whether it's open is remembered.
 */
export function Section({
  id,
  title,
  count,
  actions,
  defaultOpen = true,
  children,
}: {
  id?: string;
  title: ReactNode;
  count?: number;
  /** Buttons on the header's right, shown on hover. */
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = usePersistentFlag(id ? `agentchainer.section.${id}` : null, defaultOpen);
  return (
    <section className="section">
      <div className="section-header">
        <button type="button" className="section-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="section-title">{title}</span>
          {count !== undefined && <span className="section-count">{count}</span>}
        </button>
        {actions && <span className="section-actions">{actions}</span>}
      </div>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

/** A quiet placeholder for an empty list: an icon and one line. */
export function EmptyState({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <p className="empty-state">
      {icon}
      <span>{children}</span>
    </p>
  );
}
