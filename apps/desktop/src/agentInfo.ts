import type { EnvCheck, MethodResult } from "@agentchainer/protocol";

/**
 * The agent harnesses the app can run (UX-23): Claude Code, OpenAI's Codex CLI and Google's Antigravity CLI, each
 * with what Settings → Agents shows about it. The app never installs or signs in to one (ADR-0002): it shows the
 * command for the person to run in their own terminal.
 */
export type AgentId = "claude" | "codex" | "agy";
export const AGENT_IDS: readonly AgentId[] = ["claude", "codex", "agy"];

type Clis = MethodResult<"agents.available">;

export type AgentStatus = {
  id: AgentId;
  installed: boolean;
  version?: string;
  /** null when it can't be told (the check hasn't run yet, or the CLI is missing). */
  signedIn: boolean | null;
  /** Claude only: older than the app needs. */
  tooOld?: boolean;
  /** Where it runs from, when the app knows. */
  path?: string;
};

/** Where to read how to install each, and the command that signs in (run by the person, in their own terminal). */
export const AGENT_LINKS: Record<AgentId, { docs: string; signIn: string }> = {
  claude: { docs: "https://code.claude.com/docs/en/setup", signIn: "claude auth login" },
  codex: { docs: "https://github.com/openai/codex", signIn: "codex login" },
  // agy has no login subcommand: it asks for a sign-in the first time it runs in a terminal.
  agy: { docs: "https://antigravity.google/docs/cli", signIn: "agy" },
};

/** The install command to show, by platform; null when the docs are the way (agy). */
export function installCommand(id: AgentId, platform: string | undefined): string | null {
  if (id === "claude") {
    return platform === "win32"
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash";
  }
  if (id === "codex") return "npm install -g @openai/codex";
  return null;
}

/** Each agent's status from the readiness check (Claude) and `agents.available` (the others). */
export function agentStatuses(env: EnvCheck | null, clis: Clis | null): AgentStatus[] {
  const claude: AgentStatus = env
    ? {
        id: "claude",
        installed: !!env.claude.path,
        ...(env.claude.version ? { version: env.claude.version.replace(/^[^\d]*/, "").split(" ")[0] } : {}),
        signedIn: env.claude.path ? (env.auth?.loggedIn ?? null) : null,
        ...(env.claude.path && !env.claude.versionOk ? { tooOld: true } : {}),
        ...(env.claude.path ? { path: env.claude.path } : {}),
      }
    : { id: "claude", installed: false, signedIn: null };
  const other = (id: "codex" | "agy"): AgentStatus => {
    const c = clis?.[id];
    if (!c) return { id, installed: false, signedIn: null };
    return {
      id,
      installed: c.installed,
      ...(c.version ? { version: c.version.replace(/^[^\d]*/, "") } : {}),
      signedIn: c.installed ? c.signedIn : null,
    };
  };
  return [claude, other("codex"), other("agy")];
}

/** What the person should do next for an agent, if anything. */
export function nextStep(s: AgentStatus): "install" | "update" | "signIn" | null {
  if (!s.installed) return "install";
  if (s.tooOld) return "update";
  if (s.signedIn === false) return "signIn";
  return null;
}
