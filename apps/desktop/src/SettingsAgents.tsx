import type { EnvCheck } from "@agentchainer/protocol";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleAlert, CircleCheck, CircleMinus, ExternalLink, KeyRound, Loader2, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { AGENT_LINKS, type AgentId, type AgentStatus, agentStatuses, installCommand, nextStep } from "./agentInfo.ts";
import { AGENT_LOGOS } from "./agentLogos.ts";
import { t } from "./i18n/index.ts";
import { authLabel } from "./Readiness.tsx";
import type { Settings } from "./settings.ts";
import type { AgentClis } from "./tasks/AgentPickers.tsx";
import { CopyButton } from "./ui/CopyButton.tsx";

const NAMES: Record<AgentId, () => string> = {
  claude: () => t("home.agents.claudeName"),
  codex: () => t("home.agents.codexName"),
  agy: () => t("home.agents.agyName"),
};
const MAKERS: Record<AgentId, () => string> = {
  claude: () => t("home.agents.claudeMaker"),
  codex: () => t("home.agents.codexMaker"),
  agy: () => t("home.agents.agyMaker"),
};
const USED_FOR: Record<AgentId, () => string> = {
  claude: () => t("home.agents.claudeUse"),
  codex: () => t("home.agents.codexUse"),
  agy: () => t("home.agents.agyUse"),
};
/** The setting that points the app at a different binary, per agent. */
const PATH_KEY = { claude: "claudePath", codex: "codexPath", agy: "agyPath" } as const;

/** A status as an icon and words, never color alone. */
function Pill({ tone, icon, children }: { tone: "ok" | "warn" | "off"; icon: ReactNode; children: ReactNode }) {
  return (
    <span className={`badge agent-pill tone-${tone === "off" ? "none" : tone}`}>
      {icon}
      {children}
    </span>
  );
}

function Command({ command }: { command: string }) {
  return (
    <span className="agent-command">
      <code>{command}</code>
      <CopyButton text={command} />
    </span>
  );
}

/**
 * Settings → Agents (UX-23): each agent harness the app can run, whether it's installed and signed in, where it runs
 * from, what it's used for, and what to do next. Installing and signing in happen in the person's own terminal
 * (ADR-0002); a different binary can be set per agent.
 */
export function SettingsAgents({
  env,
  clis,
  checking,
  onRecheck,
  draft,
  onDraft,
}: {
  env: EnvCheck | null;
  clis: AgentClis | null;
  checking: boolean;
  onRecheck: () => void;
  draft: Settings;
  onDraft: (next: Settings) => void;
}) {
  const statuses = agentStatuses(env, clis);
  return (
    <div className="agent-cards">
      <div className="agent-cards-head">
        <p className="field-help">{t("home.agents.intro")}</p>
        <button type="button" className="secondary small" disabled={checking} onClick={onRecheck}>
          {checking ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          {t("home.agents.checkAgain")}
        </button>
      </div>
      {statuses.map((s) => (
        <AgentCard key={s.id} status={s} env={env} draft={draft} onDraft={onDraft} />
      ))}
    </div>
  );
}

function AgentCard({
  status: s,
  env,
  draft,
  onDraft,
}: {
  status: AgentStatus;
  env: EnvCheck | null;
  draft: Settings;
  onDraft: (next: Settings) => void;
}) {
  const key = PATH_KEY[s.id];
  const custom = draft[key] ?? "";
  const step = nextStep(s);
  const install = installCommand(s.id, env?.platform);
  const docs = AGENT_LINKS[s.id].docs;
  return (
    <article className={`agent-card${s.installed ? "" : " missing"}`} aria-labelledby={`agent-${s.id}`}>
      <header className="agent-card-head">
        <span className="agent-mark" aria-hidden>
          <img src={AGENT_LOGOS[s.id]} alt="" />
        </span>
        <div className="agent-card-title">
          <h4 id={`agent-${s.id}`}>{NAMES[s.id]()}</h4>
          <span className="muted">{MAKERS[s.id]()}</span>
        </div>
        <span className="grow" />
        <div className="agent-pills">
          {s.installed ? (
            <Pill tone="ok" icon={<CircleCheck size={12} />}>
              {s.version ? t("home.agents.installedVersion", { version: s.version }) : t("home.agents.installed")}
            </Pill>
          ) : (
            <Pill tone="off" icon={<CircleMinus size={12} />}>
              {t("home.agents.notInstalled")}
            </Pill>
          )}
          {s.tooOld && (
            <Pill tone="warn" icon={<CircleAlert size={12} />}>
              {t("home.agents.tooOld", { min: env?.claude.minVersion ?? "" })}
            </Pill>
          )}
          {s.signedIn === true && (
            <Pill tone="ok" icon={<KeyRound size={12} />}>
              {s.id === "claude" && env
                ? t("home.agents.signedInAs", { method: authLabel(env) })
                : t("home.agents.signedIn")}
            </Pill>
          )}
          {s.signedIn === false && (
            <Pill tone="warn" icon={<KeyRound size={12} />}>
              {t("home.agents.notSignedIn")}
            </Pill>
          )}
        </div>
      </header>

      <dl className="agent-card-facts">
        <dt>{t("home.agents.usedFor")}</dt>
        <dd>{USED_FOR[s.id]()}</dd>
        {s.path && (
          <>
            <dt>{t("home.agents.runsFrom")}</dt>
            <dd>
              <code>{s.path}</code>
            </dd>
          </>
        )}
      </dl>

      {step === "install" && (
        <div className="agent-next">
          <p>{t("home.agents.toInstall")}</p>
          {install && <Command command={install} />}
          <button type="button" className="link" onClick={() => void openUrl(docs)}>
            <ExternalLink size={12} /> {t("home.agents.installGuide")}
          </button>
        </div>
      )}
      {step === "update" && (
        <div className="agent-next">
          <p>{t("home.agents.toUpdate")}</p>
          <Command command="claude update" />
        </div>
      )}
      {step === "signIn" && (
        <div className="agent-next">
          <p>{s.id === "agy" ? t("home.agents.toSignInAgy") : t("home.agents.toSignIn")}</p>
          <Command command={AGENT_LINKS[s.id].signIn} />
        </div>
      )}

      <details className="agent-path" open={!!custom}>
        <summary>{t("home.agents.differentBinary")}</summary>
        <div className="agent-path-body">
          <input
            value={custom}
            onChange={(e) => onDraft({ ...draft, [key]: e.target.value || null })}
            placeholder={t("home.agents.pathPlaceholder")}
            spellCheck={false}
            aria-label={t("home.agents.pathLabel", { name: NAMES[s.id]() })}
          />
          <span className="field-help">
            {s.id === "claude" ? t("home.settings.claudePathHelp") : t("home.settings.agentPathHelp")}
          </span>
        </div>
      </details>
    </article>
  );
}
