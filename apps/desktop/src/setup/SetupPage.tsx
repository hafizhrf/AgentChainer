import type { Methods } from "@agentchainer/protocol";
import {
  ArrowLeft,
  BarChart3,
  Bot,
  ClipboardList,
  FileText,
  History as HistoryIcon,
  ListChecks,
  Puzzle,
  RefreshCw,
  Rocket,
  Save,
  Server,
  ShieldCheck,
  Terminal,
  Workflow,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { FolderSwitcher } from "../FolderSwitcher.tsx";
import { t } from "../i18n/index.ts";
import { request } from "../sidecar.ts";
import { folderName } from "../tabs.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { Agents } from "./Agents.tsx";
import { Commands } from "./Commands.tsx";
import { Deploys } from "./Deploys.tsx";
import { History } from "./History.tsx";
import { McpServers } from "./McpServers.tsx";
import { Memory } from "./Memory.tsx";
import { Metrics } from "./Metrics.tsx";
import { gapsOf, Overview } from "./Overview.tsx";
import { Permissions } from "./Permissions.tsx";
import { PlanView } from "./PlanView.tsx";
import { Plugins } from "./Plugins.tsx";
import { useBootstrap } from "./useBootstrap.tsx";
import { Workflows } from "./Workflows.tsx";

type Scan = Methods["workspace.scan"]["result"];
export type SetupView =
  | "overview"
  | "plan"
  | "commands"
  | "agents"
  | "memory"
  | "plugins"
  | "mcp"
  | "permissions"
  | "workflows"
  | "deploy"
  | "metrics"
  | "history";

/**
 * Workspace settings as a full page (UX-06), laid out like an IDE's project settings: what the workspace is made of at
 * the top, sections on the left (readiness, the setup plan, detected commands, agents, CLAUDE.md, plugins, MCP servers, saved permission
 * rules,
 * the tiers' workflows, deploys, task metrics, past runs), and the section's content on the right. Opens over the session or Home; Back returns there.
 */
export function SetupPage({
  cwd,
  model,
  backLabel,
  confirm,
  onBack,
  initialView = "overview",
  folders = [],
  onFolderChange,
  workspaces = [],
  onOpenFile = async () => {},
}: {
  cwd: string;
  /** Model alias for generators ("" = the CLI's default). */
  model: string;
  backLabel: string;
  confirm: Confirm;
  onBack: () => void;
  initialView?: SetupView;
  /** A multi-folder workspace's folders, primary first (M8-01): readiness, the plan and the rest are per folder. */
  folders?: string[];
  onFolderChange?: (dir: string) => void;
  /** Every workspace the app knows, for "Apply to all workspaces". */
  workspaces?: string[];
  /** Opens a file in the person's editor (CLAUDE.md, CP-03). */
  onOpenFile?: (file: string) => Promise<void>;
}) {
  const [view, setViewNow] = useState<SetupView>(initialView);
  // The CLAUDE.md section's unsaved edits: leaving it asks first.
  const unsaved = useRef(false);
  const onDirty = useCallback((dirty: boolean) => {
    unsaved.current = dirty;
  }, []);
  /** Runs `go` once unsaved CLAUDE.md edits, if any, are confirmed to be discarded. */
  const leave = async (go: () => void) => {
    if (
      unsaved.current &&
      !(await confirm({
        title: t("setup.memory.discardTitle"),
        body: t("setup.memory.discardLeave"),
        confirmLabel: t("setup.memory.discard"),
        danger: true,
      }))
    )
      return;
    unsaved.current = false;
    go();
  };
  const setView = (next: SetupView) => void leave(() => setViewNow(next));
  const [focus, setFocus] = useState<string | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // Known once the Plugins section has listed them: listing asks the CLI to refresh its marketplaces (ADR-0010).
  const [pluginUpdates, setPluginUpdates] = useState(0);

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
    {
      id: "overview",
      label: t("setup.page.navOverview"),
      icon: <ListChecks size={16} className="nav-icon" />,
      count: gaps || null,
    },
    {
      id: "plan",
      label: t("setup.page.navPlan"),
      icon: <ClipboardList size={16} className="nav-icon" />,
      count: bootstrap.selected.size || null,
    },
    { id: "commands", label: t("setup.page.navCommands"), icon: <Terminal size={16} className="nav-icon" /> },
    { id: "agents", label: t("setup.page.navAgents"), icon: <Bot size={16} className="nav-icon" /> },
    { id: "memory", label: t("setup.page.navMemory"), icon: <FileText size={16} className="nav-icon" /> },
    {
      id: "plugins",
      label: t("setup.page.navPlugins"),
      icon: <Puzzle size={16} className="nav-icon" />,
      count: pluginUpdates || null,
    },
    { id: "mcp", label: t("setup.page.navMcp"), icon: <Server size={16} className="nav-icon" /> },
    { id: "permissions", label: t("setup.page.navPermissions"), icon: <ShieldCheck size={16} className="nav-icon" /> },
    { id: "workflows", label: t("setup.page.navWorkflows"), icon: <Workflow size={16} className="nav-icon" /> },
    { id: "deploy", label: t("setup.page.navDeploy"), icon: <Rocket size={16} className="nav-icon" /> },
    { id: "metrics", label: t("setup.page.navMetrics"), icon: <BarChart3 size={16} className="nav-icon" /> },
    {
      id: "history",
      label: t("setup.page.navHistory"),
      icon: <HistoryIcon size={16} className="nav-icon" />,
      count: bootstrap.runs.length || null,
    },
  ];
  const profile = scan?.profile;

  return (
    <div className="setup-page">
      <header className="setup-header">
        <button type="button" className="ghost small" onClick={() => void leave(onBack)}>
          <ArrowLeft size={14} />
          {backLabel}
        </button>
        <div className="setup-title">
          <h1>{t("setup.page.title")}</h1>
          {folders.length > 1 && onFolderChange ? (
            <FolderSwitcher folders={folders} current={cwd} onChange={(dir) => void leave(() => onFolderChange(dir))} />
          ) : (
            <span className="muted" title={cwd}>
              {folderName(cwd)}
            </span>
          )}
        </div>
        <div className="setup-chips">
          {profile?.stacks.map((s) => (
            <span key={s} className="chip">
              {s}
            </span>
          ))}
          {profile?.monorepo && (
            <span className="chip">{t("setup.page.monorepoChip", { name: profile.monorepo })}</span>
          )}
          {profile?.ci.map((c) => (
            <span key={c} className="chip">
              {t("setup.page.ciChip", { name: c })}
            </span>
          ))}
        </div>
        <span className="grow" />
        <IconButton label={t("setup.page.saveProfile")} onClick={() => void saveProfile()}>
          <Save size={15} />
        </IconButton>
        <IconButton
          label={t("setup.page.rescan")}
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
          <span className="grow">{t("setup.page.savedProfile", { path: saved })}</span>
        </p>
      )}

      <div className="setup-body">
        <nav className="setup-nav" aria-label={t("setup.page.sections")}>
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
          {!scan && !error && <p className="muted setup-pad">{t("setup.page.scanning")}</p>}
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
          {view === "agents" && <Agents cwd={cwd} confirm={confirm} onChanged={() => void bootstrap.load()} />}
          {view === "memory" && (
            <Memory
              cwd={cwd}
              confirm={confirm}
              notLoaded={folders.length > 1 && cwd !== folders[0]}
              onDirty={onDirty}
              onChanged={() => void bootstrap.load()}
              onGenerate={() => {
                setFocus("generate-claude-md");
                setView("plan");
              }}
              onOpenFile={onOpenFile}
            />
          )}
          {view === "plugins" && (
            <Plugins cwd={cwd} confirm={confirm} onChanged={() => void bootstrap.load()} onUpdates={setPluginUpdates} />
          )}
          {view === "mcp" && <McpServers cwd={cwd} confirm={confirm} onChanged={() => void bootstrap.load()} />}
          {view === "permissions" && <Permissions cwd={cwd} confirm={confirm} workspaces={workspaces} />}
          {view === "workflows" && <Workflows cwd={cwd} confirm={confirm} workspaces={workspaces} />}
          {view === "deploy" && <Deploys cwd={cwd} />}
          {view === "metrics" && <Metrics cwd={cwd} />}
          {view === "history" && <History bootstrap={bootstrap} />}
        </main>
      </div>
    </div>
  );
}
