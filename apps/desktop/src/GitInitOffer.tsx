import { useEffect, useState } from "react";
import { request } from "./sidecar.ts";

/**
 * Offers `git init` when the chosen workspace isn't a git repository (M1-06): without git, the agent's changes can't
 * be reviewed in the changes panel or reverted.
 */
export function GitInitOffer({ cwd }: { cwd: string }) {
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setIsRepo(null);
    // The path may still be typed: wait for a pause, and stay quiet about folders that don't exist (yet).
    const timer = setTimeout(() => {
      request("workspace.files", { cwd })
        .then((ws) => current && setIsRepo(ws.isGitRepo))
        .catch(() => current && setIsRepo(null));
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [cwd]);

  async function init() {
    try {
      await request("workspace.gitInit", { cwd });
      setIsRepo(true);
    } catch (err) {
      setError(String(err));
    }
  }

  if (isRepo !== false) return null;
  return (
    <p className="warn">
      This folder isn't a git repository, so you won't be able to review or revert the agent's changes.{" "}
      <button type="button" className="link" onClick={() => void init()}>
        Initialize git here
      </button>
      {error && <span> {error}</span>}
    </p>
  );
}
