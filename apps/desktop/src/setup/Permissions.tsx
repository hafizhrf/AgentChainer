import type { Methods, RuleScope } from "@agentchainer/protocol";
import { ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
import { request } from "../sidecar.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { EmptyState, Section } from "../ui/Section.tsx";

type Behavior = "allow" | "ask" | "deny";
type Rules = Methods["permissions.list"]["result"];
const BEHAVIOR_LABEL: Record<Behavior, string> = {
  get allow() {
    return t("setup.permissions.allow");
  },
  get ask() {
    return t("setup.permissions.ask");
  },
  get deny() {
    return t("setup.permissions.deny");
  },
};

const FILES: Record<RuleScope, { title: string; file: string; note: string }> = {
  workspace: {
    get title() {
      return t("setup.permissions.workspaceTitle");
    },
    file: ".claude/settings.local.json",
    get note() {
      return t("setup.permissions.workspaceNote");
    },
  },
  team: {
    get title() {
      return t("setup.permissions.teamTitle");
    },
    file: ".claude/settings.json",
    get note() {
      return t("setup.permissions.teamNote");
    },
  },
};

const code = (s: string) => <code>{s}</code>;

/**
 * Permission rules (M1-20, UX-05) as a section of Workspace settings: the workspace's own rules for this user, and the
 * ones committed for the team. Removing one asks first; a running session may keep using a rule it already loaded, so
 * the change is certain from the next session on.
 */
export function Permissions({ cwd, confirm }: { cwd: string; confirm: Confirm }) {
  const [rules, setRules] = useState<Rules | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRules(await request("permissions.list", { cwd }));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(scope: RuleScope, behavior: Behavior, rule: string) {
    const { file } = FILES[scope];
    const ok = await confirm({
      title: t("setup.permissions.removeTitle"),
      body: (
        <>
          <p>
            <Rich k="setup.permissions.removeBody" params={{ rule, file }} tags={{ code }} />
          </p>
          {scope === "team" && <p className="warn">{t("setup.permissions.teamWarning")}</p>}
        </>
      ),
      confirmLabel: t("setup.permissions.removeRule"),
    });
    if (!ok) return;
    try {
      await request("permissions.remove", { cwd, behavior, rule, scope });
      await load();
    } catch (err) {
      setError(String(err));
    }
  }

  const behaviors = (scope: RuleScope) =>
    rules ? (["allow", "ask", "deny"] as const).filter((b) => rules[scope][b].length > 0) : [];
  const empty = rules !== null && behaviors("workspace").length === 0 && behaviors("team").length === 0;
  return (
    <div className="setup-scroll">
      <p className="muted">
        <Rich k="setup.permissions.intro" tags={{ strong: (s) => <strong>{s}</strong> }} />
      </p>
      {error && <p className="warn">{error}</p>}
      {!rules && !error && <p className="muted">{t("setup.permissions.loading")}</p>}
      {empty && <EmptyState icon={<ShieldCheck size={14} />}>{t("setup.permissions.empty")}</EmptyState>}
      {(["workspace", "team"] as const)
        .filter((scope) => behaviors(scope).length > 0)
        .map((scope) => (
          <section key={scope} className="card rules-card">
            <div className="card-title">
              <h2>{FILES[scope].title}</h2>
              <code className="muted">{FILES[scope].file}</code>
            </div>
            <p className="field-help">{FILES[scope].note}</p>
            {behaviors(scope).map((b) => (
              <Section key={b} id={`rules.${scope}.${b}`} title={BEHAVIOR_LABEL[b]} count={rules?.[scope][b].length}>
                {rules?.[scope][b].map((rule) => (
                  <div key={rule} className="tree-item">
                    <code className="rule-text" title={rule}>
                      {rule}
                    </code>
                    <span className="tree-actions">
                      <IconButton label={t("setup.permissions.removeRule")} onClick={() => void remove(scope, b, rule)}>
                        <Trash2 size={13} />
                      </IconButton>
                    </span>
                  </div>
                ))}
              </Section>
            ))}
          </section>
        ))}
    </div>
  );
}
