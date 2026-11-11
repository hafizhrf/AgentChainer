import type { EnvCheck } from "@agentchainer/protocol";
import { invoke } from "@tauri-apps/api/core";
import { CircleCheck, CircleX, RefreshCw, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "./i18n/index.ts";
import { request } from "./sidecar.ts";
import type { AgentClis } from "./tasks/AgentPickers.tsx";

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
  // The other agents' CLIs for task steps (M9-06): shown beside Claude when they're installed, never required.
  const [clis, setClis] = useState<AgentClis | null>(null);
  useEffect(() => {
    if (env?.ready) void request("agents.available", {}).then(setClis, () => setClis(null));
  }, [env?.ready]);
  if (!env)
    return (
      <section className="card readiness compact" aria-label={t("home.readiness.label")}>
        <p className="muted">{checking ? t("home.readiness.checking") : t("home.readiness.waiting")}</p>
      </section>
    );
  const install =
    env.platform === "win32"
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash";
  const rows: { ok: boolean; label: string; fix?: string; command?: string }[] = [
    env.claude.path
      ? {
          ok: true,
          label: t("home.readiness.cliFound", { version: env.claude.version ?? t("home.readiness.versionUnknown") }),
        }
      : {
          ok: false,
          label: t("home.readiness.cliMissing"),
          fix: t("home.readiness.cliFix"),
          command: install,
        },
  ];
  if (env.claude.path) {
    rows.push(
      env.claude.versionOk
        ? { ok: true, label: t("home.readiness.versionOk", { min: env.claude.minVersion }) }
        : {
            ok: false,
            label: t("home.readiness.versionOld", { min: env.claude.minVersion }),
            fix: t("home.readiness.versionFix"),
            command: "claude update",
          },
    );
    rows.push(
      env.auth?.loggedIn
        ? { ok: true, label: t("home.readiness.signedIn", { method: authLabel(env) }) }
        : {
            ok: false,
            label: t("home.readiness.notSignedIn"),
            fix: t("home.readiness.signInFix"),
            command: "claude auth login",
          },
    );
  }
  rows.push(
    env.git.version
      ? { ok: true, label: env.git.version }
      : {
          ok: false,
          label: t("home.readiness.gitMissing"),
          fix: t("home.readiness.gitFix", { url: "https://git-scm.com/downloads" }),
        },
  );

  const recheck = (
    <button type="button" className="ghost small" disabled={checking} onClick={onRecheck}>
      <RefreshCw size={14} className={checking ? "spin" : undefined} />
      {checking ? t("home.readiness.rechecking") : t("home.readiness.recheck")}
    </button>
  );

  // Once everything is in place, one line is enough.
  if (env.ready)
    return (
      <section className="card readiness compact" aria-label={t("home.readiness.label")}>
        <CircleCheck size={18} className="readiness-ok" aria-hidden />
        <span className="grow">
          <strong>{t("home.readiness.ready")}</strong>
          <span className="muted">
            {" "}
            {t("home.readiness.summary", {
              claude: shortVersion(env.claude.version),
              auth: authLabel(env),
              git: shortVersion(env.git.version?.replace(/^git version /, "") ?? null),
            })}
            {otherClis(clis)}
          </span>
        </span>
        {recheck}
      </section>
    );

  return (
    <section className="card readiness" aria-labelledby="readiness-title">
      <div className="card-title">
        <h2 id="readiness-title">{t("home.readiness.title")}</h2>
        <span className="grow" />
        {recheck}
      </div>
      <ul>
        {rows.map((r) => (
          <li key={r.label} className={r.ok ? "ok" : "fail"}>
            {r.ok ? (
              <CircleCheck size={16} aria-label={t("home.readiness.done")} />
            ) : (
              <CircleX size={16} aria-label={t("home.readiness.missing")} />
            )}
            <div>
              {r.label}
              {r.fix && <div className="muted">{r.fix}</div>}
              {r.command && <CommandLine command={r.command} />}
            </div>
          </li>
        ))}
      </ul>
      <p className="muted">{t("home.readiness.guide")}</p>
      <div className="row">
        <button type="button" className="secondary" onClick={() => void invoke("open_terminal", { dir: null })}>
          <SquareTerminal size={14} />
          {t("home.readiness.openTerminal")}
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
        {copied ? t("shell.copyButton.copied") : t("shell.copyButton.copy")}
      </button>
    </div>
  );
}

/** " · Codex 0.157.0 · agy 1.5.4": the other agents' CLIs that are installed, or that one isn't signed in. */
function otherClis(clis: AgentClis | null): string {
  if (!clis) return "";
  const line = (name: string, c: AgentClis["codex"]) =>
    !c.installed
      ? []
      : [
          c.signedIn
            ? t("home.readiness.agentReady", { name, version: (c.version ?? "").replace(/^[^\d]*/, "") })
            : t("home.readiness.agentSignedOut", { name }),
        ];
  const parts = [...line("Codex", clis.codex), ...line("agy", clis.agy)];
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

/** "2.1.3" for "2.1.3 (Claude Code)" or "2.50.1 (Apple Git-155)". */
function shortVersion(version: string | null): string {
  return version?.split(" ")[0] ?? "";
}

export function authLabel(env: EnvCheck): string {
  const a = env.auth;
  if (!a) return t("home.readiness.authUnknown");
  if (a.method === "claude.ai") return t("home.readiness.authSubscription");
  if (a.method === "api_key") return t("home.readiness.authApiKey");
  if (a.method === "third_party") return t("home.readiness.authCloud", { provider: String(a.provider) });
  return a.method;
}
