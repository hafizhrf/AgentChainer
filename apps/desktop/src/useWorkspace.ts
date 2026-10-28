import type { WorkspaceFiles } from "@agentchainer/protocol";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { request } from "./sidecar.ts";

/**
 * The workspace's files and git status (M1-25). While `active`, the Rust core watches the folder and every change
 * triggers a refresh; inactive tabs keep their last listing.
 */
export function useWorkspace(cwd: string, active: boolean) {
  const [files, setFiles] = useState<WorkspaceFiles | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setFiles(await request("workspace.files", { cwd }));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [cwd]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    void invoke("workspace_watch", { cwd }).catch((err: unknown) => setError(`File watching is off: ${err}`));
    const off = listen<string>("workspace://changed", (e) => {
      if (e.payload === cwd) void refresh();
    });
    return () => {
      void off.then((unlisten) => unlisten());
      void invoke("workspace_unwatch", { cwd }).catch(() => undefined);
    };
  }, [cwd, active, refresh]);

  return { files, error, refresh };
}
