import { ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { request } from "../sidecar.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { EmptyState, Section } from "../ui/Section.tsx";

type Behavior = "allow" | "ask" | "deny";
const BEHAVIOR_LABEL: Record<Behavior, string> = { allow: "Always allowed", ask: "Always ask", deny: "Always denied" };

/**
 * Permission rules saved by "Always allow" (M1-20), from `.claude/settings.local.json`, as a section of Workspace
 * settings. Removing one asks first; a running session may keep using a rule it already loaded, so the change is
 * certain from the next session on.
 */
export function Permissions({ cwd, confirm }: { cwd: string; confirm: Confirm }) {
  const [rules, setRules] = useState<Record<Behavior, string[]> | null>(null);
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

  async function remove(behavior: Behavior, rule: string) {
    const ok = await confirm({
      title: "Remove this rule?",
      body: (
        <p>
          <code>{rule}</code> is removed from <code>.claude/settings.local.json</code>. Claude will ask again for it,
          certainly in new sessions.
        </p>
      ),
      confirmLabel: "Remove rule",
    });
    if (!ok) return;
    try {
      await request("permissions.remove", { cwd, behavior, rule });
      await load();
    } catch (err) {
      setError(String(err));
    }
  }

  const behaviors = rules ? (["allow", "ask", "deny"] as const).filter((b) => rules[b].length > 0) : [];
  return (
    <div className="setup-scroll">
      <p className="muted">
        Choosing <strong>Always allow</strong> on an approval saves a rule here. Rules live in{" "}
        <code>.claude/settings.local.json</code>, which stays out of git, and apply to this workspace only.
      </p>
      {error && <p className="warn">{error}</p>}
      {!rules && !error && <p className="muted">Loading…</p>}
      {rules && behaviors.length === 0 && <EmptyState icon={<ShieldCheck size={14} />}>No saved rules yet.</EmptyState>}
      {behaviors.map((b) => (
        <section key={b} className="card rules-card">
          <Section id={`rules.${b}`} title={BEHAVIOR_LABEL[b]} count={rules?.[b].length ?? 0}>
            {rules?.[b].map((rule) => (
              <div key={rule} className="tree-item">
                <code className="rule-text" title={rule}>
                  {rule}
                </code>
                <span className="tree-actions">
                  <IconButton label="Remove rule" onClick={() => void remove(b, rule)}>
                    <Trash2 size={13} />
                  </IconButton>
                </span>
              </div>
            ))}
          </Section>
        </section>
      ))}
    </div>
  );
}
