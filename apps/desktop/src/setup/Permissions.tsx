import type { Methods, RuleScope } from "@agentchainer/protocol";
import { ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { request } from "../sidecar.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { EmptyState, Section } from "../ui/Section.tsx";

type Behavior = "allow" | "ask" | "deny";
type Rules = Methods["permissions.list"]["result"];
const BEHAVIOR_LABEL: Record<Behavior, string> = { allow: "Always allowed", ask: "Always ask", deny: "Always denied" };

const FILES: Record<RuleScope, { title: string; file: string; note: string }> = {
  workspace: {
    title: "Just me",
    file: ".claude/settings.local.json",
    note: "Kept out of git, so only you have these.",
  },
  team: {
    title: "Shared with the team",
    file: ".claude/settings.json",
    note: "Committed with the project, so everyone who opens it gets these.",
  },
};

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
      title: "Remove this rule?",
      body: (
        <>
          <p>
            <code>{rule}</code> is removed from <code>{file}</code>. Claude will ask again for it, certainly in new
            sessions.
          </p>
          {scope === "team" && (
            <p className="warn">This file is committed: once you commit the change, it applies to your whole team.</p>
          )}
        </>
      ),
      confirmLabel: "Remove rule",
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
        Choosing <strong>Always allow</strong> on an approval saves a rule here, for you only or for your team.
        Session-only rules end with the session and aren't listed.
      </p>
      {error && <p className="warn">{error}</p>}
      {!rules && !error && <p className="muted">Loading…</p>}
      {empty && <EmptyState icon={<ShieldCheck size={14} />}>No saved rules yet.</EmptyState>}
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
                      <IconButton label="Remove rule" onClick={() => void remove(scope, b, rule)}>
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
