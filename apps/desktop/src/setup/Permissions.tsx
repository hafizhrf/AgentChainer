import { folderKey, type Methods, PermissionRuleTextSchema, type RuleScope } from "@agentchainer/protocol";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
import { request } from "../sidecar.ts";
import { folderName } from "../tabs.ts";
import { Field } from "../ui/Field.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { EmptyState, Section } from "../ui/Section.tsx";
import { Select } from "../ui/Select.tsx";

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
  user: {
    get title() {
      return t("setup.permissions.userTitle");
    },
    file: "~/.claude/settings.json",
    get note() {
      return t("setup.permissions.userNote");
    },
  },
};

const code = (s: string) => <code>{s}</code>;

/**
 * Permission rules (M1-20, UX-05) as a section of Workspace settings: the workspace's own rules for this user, and the
 * ones committed for the team. Removing one asks first; a running session may keep using a rule it already loaded, so
 * the change is certain from the next session on.
 */
export function Permissions({
  cwd,
  confirm,
  workspaces = [],
}: {
  cwd: string;
  confirm: Confirm;
  /** Every workspace the app knows, for adding a rule to each. */
  workspaces?: string[];
}) {
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
          {scope === "user" && <p className="field-help">{t("setup.permissions.userWarning")}</p>}
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
  const empty =
    rules !== null &&
    behaviors("workspace").length === 0 &&
    behaviors("team").length === 0 &&
    behaviors("user").length === 0;
  return (
    <div className="setup-scroll">
      <p className="muted">
        <Rich k="setup.permissions.intro" tags={{ strong: (s) => <strong>{s}</strong> }} />
      </p>
      {error && <p className="warn">{error}</p>}
      {!rules && !error && <p className="muted">{t("setup.permissions.loading")}</p>}
      <AddRule cwd={cwd} workspaces={workspaces} onAdded={() => void load()} />
      {empty && <EmptyState icon={<ShieldCheck size={14} />}>{t("setup.permissions.empty")}</EmptyState>}
      {(["workspace", "team", "user"] as const)
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

/** Where a new rule goes: one of the three files, or this workspace's own file copied into every known workspace. */
type Target = RuleScope | "everyWorkspace";

/**
 * Adds a rule by hand (UX-19): to this workspace (just you, or the team), to every project through your user
 * settings (ADR-0013), or copied into each workspace the app knows. The CLI's own syntax: `Bash(npm test:*)`,
 * `Edit(src/**)`, `WebFetch(domain:example.com)`, `mcp__server__tool`.
 */
function AddRule({ cwd, workspaces, onAdded }: { cwd: string; workspaces: string[]; onAdded: () => void }) {
  const [behavior, setBehavior] = useState<Behavior>("allow");
  const [rule, setRule] = useState("");
  const [target, setTarget] = useState<Target>("workspace");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const text = rule.trim();
  const valid = PermissionRuleTextSchema.safeParse(text).success;
  const others = workspaces.filter((w) => folderKey(w) !== folderKey(cwd));

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (target === "everyWorkspace") {
        const failed: string[] = [];
        for (const dir of [cwd, ...others]) {
          try {
            await request("permissions.add", { cwd: dir, behavior, rule: text, scope: "workspace" });
          } catch {
            failed.push(folderName(dir));
          }
        }
        const done = others.length + 1 - failed.length;
        setNote(
          failed.length
            ? t("setup.permissions.addedSome", { count: done, failed: failed.join(", ") })
            : t("setup.permissions.addedAll", { count: done }),
        );
      } else {
        await request("permissions.add", { cwd, behavior, rule: text, scope: target });
      }
      setRule("");
      onAdded();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card rules-card">
      <div className="card-title">
        <h2>{t("setup.permissions.addTitle")}</h2>
      </div>
      <form className="add-rule" onSubmit={(e) => void add(e)}>
        <Field label={t("setup.permissions.ruleLabel")} help={t("setup.permissions.ruleHelp")}>
          <input
            value={rule}
            onChange={(e) => setRule(e.target.value)}
            placeholder={t("setup.permissions.rulePlaceholder")}
            spellCheck={false}
            aria-invalid={text !== "" && !valid}
          />
        </Field>
        <div className="field-row">
          <Field label={t("setup.permissions.behaviorLabel")}>
            <Select
              label={t("setup.permissions.behaviorLabel")}
              value={behavior}
              onChange={(v) => setBehavior(v as Behavior)}
              options={(["allow", "ask", "deny"] as const).map((b) => ({ value: b, label: BEHAVIOR_LABEL[b] }))}
            />
          </Field>
          <Field label={t("setup.permissions.whereLabel")}>
            <Select
              label={t("setup.permissions.whereLabel")}
              value={target}
              onChange={(v) => setTarget(v as Target)}
              options={[
                { value: "workspace", label: FILES.workspace.title, hint: FILES.workspace.file },
                { value: "team", label: FILES.team.title, hint: FILES.team.file },
                { value: "user", label: FILES.user.title, hint: FILES.user.file },
                ...(others.length
                  ? [
                      {
                        value: "everyWorkspace",
                        label: t("setup.permissions.everyWorkspace"),
                        hint: t("setup.permissions.everyWorkspaceHint", { count: others.length + 1 }),
                      },
                    ]
                  : []),
              ]}
            />
          </Field>
        </div>
        {target === "team" && <p className="warn">{t("setup.permissions.teamWarning")}</p>}
        {target === "user" && <p className="field-help">{t("setup.permissions.userWarning")}</p>}
        <div className="card-footer">
          {text !== "" && !valid && <span className="warn">{t("setup.permissions.badRule")}</span>}
          {note && (
            <span className="muted" role="status">
              {note}
            </span>
          )}
          {error && <span className="warn">{error}</span>}
          <span className="grow" />
          <button type="submit" disabled={!valid || busy}>
            <Plus size={14} aria-hidden />
            {t("setup.permissions.add")}
          </button>
        </div>
      </form>
    </section>
  );
}
