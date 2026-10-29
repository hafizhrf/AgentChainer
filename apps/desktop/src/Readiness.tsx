import type { EnvCheck } from "@agentchainer/protocol";
import { invoke } from "@tauri-apps/api/core";
import { CircleCheck, CircleX, RefreshCw, SquareTerminal } from "lucide-react";
import { useState } from "react";

/**
 * Onboarding readiness and tutorial (spike S5, checklist M1-04/M1-05). The app never signs in for the user: it shows
 * the command to run in their own terminal, opens that terminal, and re-checks (ADR-0002, docs/guides/AUTH_SETUP.md).
 */
export function Readiness({
  env,
  checking,
  onRecheck,
}: {
  env: EnvCheck | null;
  checking: boolean;
  onRecheck: () => void;
}) {
  if (!env)
    return (
      <section className="card readiness compact" aria-label="Setup check">
        <p className="muted">{checking ? "Checking your setup…" : "Waiting for the agent runtime…"}</p>
      </section>
    );
  const install =
    env.platform === "win32"
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash";
  const rows: { ok: boolean; label: string; fix?: string; command?: string }[] = [
    env.claude.path
      ? { ok: true, label: `Claude Code CLI found (${env.claude.version ?? "version unknown"})` }
      : {
          ok: false,
          label: "Claude Code CLI not found",
          fix: "Install it in your terminal, then open a new terminal window:",
          command: install,
        },
  ];
  if (env.claude.path) {
    rows.push(
      env.claude.versionOk
        ? { ok: true, label: `Version ${env.claude.minVersion} or newer` }
        : {
            ok: false,
            label: `Version older than ${env.claude.minVersion}`,
            fix: "Update it in your terminal:",
            command: "claude update",
          },
    );
    rows.push(
      env.auth?.loggedIn
        ? { ok: true, label: `Signed in (${authLabel(env)})` }
        : {
            ok: false,
            label: "Not signed in",
            fix: "Sign in yourself in your terminal. AgentChainer never handles your login:",
            command: "claude auth login",
          },
    );
  }
  rows.push(
    env.git.version
      ? { ok: true, label: env.git.version }
      : { ok: false, label: "git not found", fix: "Install git from https://git-scm.com/downloads, then re-check." },
  );

  const recheck = (
    <button type="button" className="ghost small" disabled={checking} onClick={onRecheck}>
      <RefreshCw size={14} className={checking ? "spin" : undefined} />
      {checking ? "Checking…" : "Re-check"}
    </button>
  );

  // Once everything is in place, one line is enough.
  if (env.ready)
    return (
      <section className="card readiness compact" aria-label="Setup check">
        <CircleCheck size={18} className="readiness-ok" aria-hidden />
        <span className="grow">
          <strong>Ready</strong>
          <span className="muted">
            {" "}
            · Claude CLI {shortVersion(env.claude.version)} · signed in with {authLabel(env)} · git{" "}
            {shortVersion(env.git.version?.replace(/^git version /, "") ?? null)}
          </span>
        </span>
        {recheck}
      </section>
    );

  return (
    <section className="card readiness" aria-labelledby="readiness-title">
      <div className="card-title">
        <h2 id="readiness-title">Set up Claude</h2>
        <span className="grow" />
        {recheck}
      </div>
      <ul>
        {rows.map((r) => (
          <li key={r.label} className={r.ok ? "ok" : "fail"}>
            {r.ok ? <CircleCheck size={16} aria-label="Done" /> : <CircleX size={16} aria-label="Missing" />}
            <div>
              {r.label}
              {r.fix && <div className="muted">{r.fix}</div>}
              {r.command && <CommandLine command={r.command} />}
            </div>
          </li>
        ))}
      </ul>
      <p className="muted">
        Step-by-step guide for each OS: Help → Getting Started. Claude installed somewhere unusual? Set the Claude CLI
        path in Settings.
      </p>
      <div className="row">
        <button type="button" className="secondary" onClick={() => void invoke("open_terminal", { dir: null })}>
          <SquareTerminal size={14} />
          Open terminal
        </button>
      </div>
    </section>
  );
}

function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command-line">
      <code className="command">{command}</code>
      <button
        type="button"
        className="secondary small"
        onClick={() =>
          void navigator.clipboard.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** "2.1.3" for "2.1.3 (Claude Code)" or "2.50.1 (Apple Git-155)". */
function shortVersion(version: string | null): string {
  return version?.split(" ")[0] ?? "";
}

function authLabel(env: EnvCheck): string {
  const a = env.auth;
  if (!a) return "unknown";
  if (a.method === "claude.ai") return "Claude subscription";
  if (a.method === "api_key") return "API key";
  if (a.method === "third_party") return `cloud provider: ${a.provider}`;
  return a.method;
}
