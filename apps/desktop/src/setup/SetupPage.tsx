import type { Methods } from "@agentchainer/protocol";
import { ArrowLeft, ClipboardList, History as HistoryIcon, ListChecks, RefreshCw, Save, Terminal } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { request } from "../sidecar.ts";
import { folderName } from "../tabs.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { Commands } from "./Commands.tsx";
import { History } from "./History.tsx";
import { gapsOf, Overview } from "./Overview.tsx";
import { PlanView } from "./PlanView.tsx";
import { useBootstrap } from "./useBootstrap.tsx";

type Scan = Methods["workspace.scan"]["result"];
export type SetupView = "overview" | "plan" | "commands" | "history";

/**
 * Workspace setup as a full page (UX-06), laid out like an IDE's project settings: what the workspace is made of at
 * the top, sections on the left (readiness, the bootstrap plan, detected commands, past runs), and the section's
 * content on the right. Opens over the session or Home; Back returns there.
 */
export function SetupPage({
  cwd,
  model,
  backLabel,
  confirm,
  onBack,
  initialView = "overview",
}: {
  cwd: string;
  /** Model alias for generators ("" = the CLI's default). */
  model: string;
  backLabel: string;
  confirm: Confirm;
  onBack: () => void;
  initialView?: SetupView;
}) {
  const [view, setView] = useState<SetupView>(initialView);
  const [focus, setFocus] = useState<string | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const rescan = useCallback(async () => {
    try {
      setScan(await request("workspace.scan", { cwd }));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [cwd]);

  useEffect(() => {
    void rescan();
  }, [rescan]);

  const bootstrap = useBootstrap(cwd, model, confirm, () => void rescan());

  async function saveProfile() {
    try {
      setSaved((await request("workspace.saveProfile", { cwd })).path);
    } catch (err) {
      setError(String(err));
    }
  }

  const gaps = scan ? gapsOf(scan.findings).length : null;
  const nav: { id: SetupView; label: string; icon: ReactNode; count?: number | null }[] = [
    { id: "overview", label: "Overview", icon: <ListChecks size={16} className="nav-icon" />, count: gaps || null },
    {
      id: "plan",
      label: "Plan",
      icon: <ClipboardList size={16} className="nav-icon" />,
      count: bootstrap.selected.size || null,
    },
    { id: "commands", label: "Commands", icon: <Terminal size={16} className="nav-icon" /> },
    {
      id: "history",
      label: "History",
      icon: <HistoryIcon size={16} className="nav-icon" />,
      count: bootstrap.runs.length || null,
    },
  ];
  const profile = scan?.profile;

  return (
    <div className="setup-page">
      <header className="setup-header">
        <button type="button" className="ghost small" onClick={onBack}>
          <ArrowLeft size={14} />
          {backLabel}
        </button>
        <div className="setup-title">
          <h1>Workspace setup</h1>
          <span className="muted" title={cwd}>
            {folderName(cwd)}
          </span>
        </div>
        <div className="setup-chips">
          {profile?.stacks.map((s) => (
            <span key={s} className="chip">
              {s}
            </span>
          ))}
          {profile?.monorepo && <span className="chip">monorepo · {profile.monorepo}</span>}
          {profile?.ci.map((c) => (
            <span key={c} className="chip">
              CI · {c}
            </span>
          ))}
        </div>
        <span className="grow" />
        <IconButton
          label="Save profile (.agentchainer/profile.json, kept out of git)"
          onClick={() => void saveProfile()}
        >
          <Save size={15} />
        </IconButton>
        <IconButton
          label="Rescan"
          onClick={() => {
            void rescan();
            void bootstrap.load();
          }}
        >
          <RefreshCw size={15} />
        </IconButton>
      </header>
      {saved && (
        <p className="banner">
          <span className="grow">Saved the profile to {saved} (ignored by git).</span>
        </p>
      )}

      <div className="setup-body">
        <nav className="setup-nav" aria-label="Setup sections">
          {nav.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`setup-nav-item${view === n.id ? " active" : ""}`}
              aria-current={view === n.id ? "page" : undefined}
              onClick={() => setView(n.id)}
            >
              {n.icon}
              <span className="grow">{n.label}</span>
              {n.count ? <span className="count">{n.count}</span> : null}
            </button>
          ))}
        </nav>
        <main className="setup-content">
          {error && <p className="warn setup-pad">{error}</p>}
          {!scan && !error && <p className="muted setup-pad">Scanning…</p>}
          {scan && view === "overview" && (
            <Overview
              scan={scan}
              actions={bootstrap.plan?.actions}
              onFix={(id) => {
                setFocus(id);
                setView("plan");
              }}
            />
          )}
          {view === "plan" && <PlanView bootstrap={bootstrap} focus={focus} onFocus={setFocus} />}
          {scan && view === "commands" && <Commands profile={scan.profile} />}
          {view === "history" && <History bootstrap={bootstrap} />}
        </main>
      </div>
    </div>
  );
}
