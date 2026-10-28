import { type ReactNode, useCallback, useState } from "react";

export type ConfirmOptions = { title: string; body: ReactNode; confirmLabel: string; danger?: boolean };
export type Confirm = (options: ConfirmOptions) => Promise<boolean>;

/**
 * An in-app confirmation dialog. `window.confirm` isn't reliable inside the Tauri webview on every OS, and destructive
 * actions (delete a session, rewind files) need room to explain what will happen.
 */
export function useConfirm(): [Confirm, ReactNode] {
  const [open, setOpen] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);

  const confirm = useCallback<Confirm>((options) => new Promise((resolve) => setOpen({ ...options, resolve })), []);

  const close = (ok: boolean) => {
    open?.resolve(ok);
    setOpen(null);
  };

  const dialog = open && (
    <div className="overlay">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{open.title}</h2>
        <div>{open.body}</div>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={() => close(false)}>
            Cancel
          </button>
          <button type="button" className={open.danger ? "danger" : ""} onClick={() => close(true)}>
            {open.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
  return [confirm, dialog];
}
