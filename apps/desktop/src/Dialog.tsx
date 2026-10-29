import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";

/**
 * A modal dialog (Radix Dialog): focus is trapped, Esc and the close button dismiss it, and it is announced as a
 * dialog. `actions` render in the footer, right-aligned. Clicks outside never close it, so a stray click can't throw
 * away a form. A dialog that must be answered (a tool approval) sets `dismissible={false}`.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  size = "md",
  role = "dialog",
  dismissible = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  size?: "md" | "lg";
  role?: "dialog" | "alertdialog";
  dismissible?: boolean;
}) {
  const content = useRef<HTMLDivElement>(null);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay" />
        <RadixDialog.Content
          className={`dialog dialog-${size}`}
          ref={content}
          role={role}
          onInteractOutside={(e) => e.preventDefault()}
          // Focus the dialog itself, not its first button: Tab reaches the controls, and nothing looks pre-selected.
          // A control with autoFocus (e.g. Deny on risky approvals) already holds focus and keeps it.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (!content.current?.contains(document.activeElement)) content.current?.focus();
          }}
          {...(dismissible ? {} : { onEscapeKeyDown: (e: KeyboardEvent) => e.preventDefault() })}
        >
          <header className="dialog-header">
            <RadixDialog.Title>{title}</RadixDialog.Title>
            {dismissible && (
              <RadixDialog.Close asChild>
                <button type="button" className="ghost icon" aria-label="Close">
                  <X size={16} />
                </button>
              </RadixDialog.Close>
            )}
          </header>
          {description ? (
            <RadixDialog.Description className="dialog-description muted">{description}</RadixDialog.Description>
          ) : (
            <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
          )}
          <div className="dialog-body">{children}</div>
          {actions && <footer className="dialog-actions">{actions}</footer>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export type ConfirmOptions = { title: string; body: ReactNode; confirmLabel: string; danger?: boolean };
export type Confirm = (options: ConfirmOptions) => Promise<boolean>;

/**
 * An in-app confirmation dialog. `window.confirm` isn't reliable inside the Tauri webview on every OS, and destructive
 * actions (delete a session, rewind files) need room to explain what will happen.
 */
export function useConfirm(): [Confirm, ReactNode] {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);

  const confirm = useCallback<Confirm>((options) => new Promise((resolve) => setPending({ ...options, resolve })), []);

  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const dialog = (
    <Modal
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) close(false);
      }}
      title={pending?.title ?? ""}
      role="alertdialog"
      actions={
        <>
          <button type="button" className="secondary" onClick={() => close(false)}>
            Cancel
          </button>
          <button type="button" className={pending?.danger ? "danger" : ""} onClick={() => close(true)}>
            {pending?.confirmLabel}
          </button>
        </>
      }
    >
      {pending?.body}
    </Modal>
  );
  return [confirm, dialog];
}
