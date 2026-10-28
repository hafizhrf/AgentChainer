import { open } from "@tauri-apps/plugin-dialog";

/**
 * Workspace selection (checklist M1-06): native folder picker, recent workspaces, or a typed path.
 * There's no default folder: owner testing showed a home-folder workspace lets the agent roam the whole home
 * directory, so the home folder gets a warning. Multiple workspaces as tabs come with multi-session support.
 */
export function WorkspacePicker({
  value,
  onChange,
  recent,
  homeDir,
}: {
  value: string;
  onChange: (dir: string) => void;
  recent: string[];
  homeDir: string | null;
}) {
  async function browse() {
    const picked = await open({ directory: true, multiple: false, title: "Choose a project folder" });
    if (typeof picked === "string") onChange(picked);
  }
  const isHome = homeDir !== null && value.trim().replace(/[\\/]+$/, "") === homeDir;

  return (
    <div className="workspace-picker">
      <span className="label">Workspace folder</span>
      <div className="row">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={homeDir ? `e.g. ${homeDir}/projects/my-app` : "Path to a project folder"}
          spellCheck={false}
          aria-label="Workspace folder"
        />
        <button type="button" className="secondary" onClick={() => void browse()}>
          Choose folder…
        </button>
      </div>
      {isHome && (
        <p className="warn">
          That's your whole home folder. Pick a single project folder so the agent stays inside it.
        </p>
      )}
      {recent.length > 0 && (
        <div className="recent">
          <span className="muted">Recent:</span>
          {recent.map((dir) => (
            <button type="button" key={dir} className="link" title={dir} onClick={() => onChange(dir)}>
              {shortName(dir)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function shortName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || dir;
}
