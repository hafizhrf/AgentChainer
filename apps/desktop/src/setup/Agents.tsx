import {
  type AgentDefinition,
  type AgentTemplate,
  isAutoAgent,
  KNOWN_TOOLS,
  withAutoWording,
} from "@agentchainer/protocol";
import { Bot, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
import { request } from "../sidecar.ts";
import { Field } from "../ui/Field.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { EmptyState } from "../ui/Section.tsx";
import { Select } from "../ui/Select.tsx";
import {
  blankDraft,
  cloneDraft,
  type Draft,
  draftOf,
  draftProblems,
  inputOf,
  otherTools,
  templateDraft,
  toggleTool,
  withOtherTools,
} from "./agentDraft.ts";

const models = () => [
  { value: "", label: t("setup.agents.modelDefault"), hint: t("setup.agents.modelDefaultHint") },
  { value: "inherit", label: t("setup.agents.modelInherit") },
  { value: "haiku", label: t("setup.agents.modelHaiku") },
  { value: "sonnet", label: t("setup.agents.modelSonnet") },
  { value: "opus", label: t("setup.agents.modelOpus") },
];

const GROUPS: Record<keyof typeof KNOWN_TOOLS, string> = {
  get read() {
    return t("setup.agents.groupRead");
  },
  get edit() {
    return t("setup.agents.groupEdit");
  },
  get shell() {
    return t("setup.agents.groupShell");
  },
  get web() {
    return t("setup.agents.groupWeb");
  },
  get other() {
    return t("setup.agents.groupOther");
  },
};

const code = (s: string) => <code>{s}</code>;
const strong = (s: string) => <strong>{s}</strong>;

const where = (scope: Draft["scope"]) => (scope === "user" ? "~/.claude/agents/" : ".claude/agents/");

/**
 * The agent library (M4-06) and agent profiles (M8-04) as a section of Workspace settings: the project's subagents
 * (`.claude/agents/`, each change a run History can roll back) and the user's own (`~/.claude/agents/`, written in
 * place). New ones start blank, from a shipped role or from a starter; any can be cloned. The form checks each one
 * as it's typed, and its tools are what the app allows when it runs the agent as a chat or a Team worker.
 */
export function Agents({ cwd, confirm, onChanged }: { cwd: string; confirm: Confirm; onChanged: () => void }) {
  const [agents, setAgents] = useState<AgentDefinition[] | null>(null);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setAgents((await request("agents.list", { cwd })).agents);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [cwd]);

  useEffect(() => {
    void load();
    request("agents.templates", {})
      .then((r) => setTemplates(r.templates))
      .catch(() => undefined);
  }, [load]);

  /** Names a draft can't take: the other agents' in the scope it's saved to. */
  const taken = (d: Draft) =>
    (agents ?? [])
      .filter((a) => a.scope === d.scope)
      .map((a) => a.file.split("/").pop()?.replace(/\.md$/, "") ?? a.name)
      .filter((n) => n !== d.previous);

  async function save() {
    if (!draft) return;
    if (draft.scope === "user" && draft.previous === undefined) {
      const ok = await confirm({
        title: t("setup.agents.saveUserTitle", { name: draft.name }),
        body: (
          <p>
            <Rich
              k="setup.agents.saveUserBody"
              params={{ file: `~/.claude/agents/${draft.name}.md` }}
              tags={{ code }}
            />
          </p>
        ),
        confirmLabel: t("setup.agents.saveAgent"),
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await request("agents.save", {
        cwd,
        agent: inputOf(draft),
        ...(draft.previous !== undefined ? { previousName: draft.previous } : {}),
      });
      setDraft(null);
      setError(null);
      onChanged();
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(a: AgentDefinition) {
    const name = a.file.split("/").pop()?.replace(/\.md$/, "") ?? a.name;
    const ok = await confirm({
      title: t("setup.agents.deleteTitle", { name: a.name }),
      body: (
        <p>
          <Rich k="setup.agents.deleteBody" params={{ file: a.file }} tags={{ code }} />{" "}
          {a.scope === "user" ? t("setup.agents.deleteUserNote") : t("setup.agents.deleteProjectNote")}
          {a.role ? ` ${t("setup.agents.deleteRoleNote")}` : ""}
        </p>
      ),
      confirmLabel: t("setup.agents.deleteAgent"),
    });
    if (!ok) return;
    try {
      await request("agents.delete", { cwd, name, scope: a.scope });
      onChanged();
      await load();
    } catch (err) {
      setError(String(err));
    }
  }

  const form = (d: Draft) => (
    <AgentForm
      key="form"
      draft={d}
      templates={templates}
      taken={taken(d)}
      allTaken={(scope) => taken({ ...d, scope })}
      saving={saving}
      onChange={setDraft}
      onSave={() => void save()}
      onCancel={() => setDraft(null)}
    />
  );
  const rows = (list: AgentDefinition[]) =>
    list.map((a) =>
      draft?.previous !== undefined && draft.scope === a.scope && draft.previous === draftOf(a).previous ? (
        form(draft)
      ) : (
        <AgentRow
          key={a.file}
          agent={a}
          {...(a.error
            ? {}
            : {
                onEdit: () => setDraft(draftOf(a)),
                onClone: () =>
                  setDraft(
                    cloneDraft(
                      a,
                      (agents ?? []).filter((x) => x.scope === a.scope).map((x) => x.name),
                    ),
                  ),
              })}
          onDelete={() => void remove(a)}
        />
      ),
    );

  const project = agents?.filter((a) => a.scope === "project") ?? [];
  const user = agents?.filter((a) => a.scope === "user") ?? [];
  return (
    <div className="setup-scroll">
      <p className="muted">
        <Rich k="setup.agents.intro" tags={{ strong }} />
      </p>
      {error && <p className="warn">{error}</p>}
      {!agents && !error && <p className="muted">{t("setup.agents.loading")}</p>}

      {agents && (
        <section className="card agents-card">
          <div className="card-title">
            <h2>{t("setup.agents.thisProject")}</h2>
            <code className="muted">{where("project")}</code>
            <span className="grow" />
            {!draft && (
              <button type="button" className="secondary small" onClick={() => setDraft(blankDraft())}>
                <Plus size={13} />
                {t("setup.agents.newAgent")}
              </button>
            )}
          </div>
          <p className="field-help">{t("setup.agents.projectHelp")}</p>
          {draft && draft.previous === undefined && form(draft)}
          {project.length === 0 && !(draft && draft.previous === undefined) && (
            <EmptyState icon={<Bot size={14} />}>{t("setup.agents.noProjectAgents")}</EmptyState>
          )}
          {rows(project)}
        </section>
      )}

      {agents && (
        <section className="card agents-card">
          <div className="card-title">
            <h2>{t("setup.agents.yours")}</h2>
            <code className="muted">{where("user")}</code>
          </div>
          <p className="field-help">{t("setup.agents.userHelp")}</p>
          {user.length === 0 && <EmptyState icon={<Bot size={14} />}>{t("setup.agents.noUserAgents")}</EmptyState>}
          {rows(user)}
        </section>
      )}
    </div>
  );
}

function AgentRow({
  agent: a,
  onEdit,
  onClone,
  onDelete,
}: {
  agent: AgentDefinition;
  onEdit?: () => void;
  onClone?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="agent-row">
      <div className="agent-row-head">
        <Bot size={14} aria-hidden />
        <strong>{a.name}</strong>
        {!a.error && (
          <span className={`chip${a.auto ? " on" : ""}`}>
            {a.auto ? t("setup.agents.auto") : t("setup.agents.manual")}
          </span>
        )}
        {a.role && <span className="chip">{t("setup.agents.taskRole")}</span>}
        {a.model && <span className="chip">{a.model}</span>}
        <span className="grow" />
        {onEdit && (
          <IconButton label={t("setup.agents.edit", { name: a.name })} onClick={onEdit}>
            <Pencil size={13} />
          </IconButton>
        )}
        {onClone && (
          <IconButton label={t("setup.agents.clone", { name: a.name })} onClick={onClone}>
            <Copy size={13} />
          </IconButton>
        )}
        {onDelete && (
          <IconButton label={t("setup.agents.delete", { name: a.name })} onClick={onDelete}>
            <Trash2 size={13} />
          </IconButton>
        )}
      </div>
      {a.error ? (
        <p className="warn">
          <Rich k="setup.agents.unreadable" params={{ file: a.file }} tags={{ code }} /> {a.error}
        </p>
      ) : (
        <>
          <p className="agent-row-desc">{a.description}</p>
          <p className="field-help">
            {a.tools ? t("setup.agents.toolsList", { tools: a.tools }) : t("setup.agents.allTools")}
          </p>
        </>
      )}
    </div>
  );
}

function AgentForm({
  draft,
  templates,
  taken,
  allTaken,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft;
  templates: AgentTemplate[];
  /** The other agents' names where it's saved. */
  taken: string[];
  /** The names taken in a scope, for a template picked before the scope. */
  allTaken: (scope: Draft["scope"]) => string[];
  saving: boolean;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const isNew = draft.previous === undefined;
  const known = models();
  const modelOptions =
    draft.model && !known.some((m) => m.value === draft.model)
      ? [...known, { value: draft.model, label: draft.model }]
      : known;
  const problems = draftProblems(draft, taken);
  const [others, setOthers] = useState(otherTools(draft.tools));
  const [start, setStart] = useState("");
  const starts = [
    { value: "", label: t("setup.agents.blank") },
    ...templates.map((tpl) => ({
      value: tpl.id,
      label:
        tpl.source === "role"
          ? t("setup.agents.fromRole", { name: tpl.name })
          : t("setup.agents.fromStarter", { name: tpl.name }),
      hint: tpl.description,
    })),
  ];
  return (
    <form
      className="agent-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (problems.length === 0 && !saving) onSave();
      }}
    >
      {isNew && (
        <div className="field-row">
          <Field label={t("setup.agents.startFrom")} help={t("setup.agents.startFromHelp")}>
            <Select
              label={t("setup.agents.startFrom")}
              value={start}
              options={starts}
              onChange={(id) => {
                setStart(id);
                const tpl = templates.find((x) => x.id === id);
                const next = tpl ? templateDraft(tpl, draft.scope, allTaken(draft.scope)) : { ...draft };
                onChange(next);
                setOthers(otherTools(next.tools));
              }}
            />
          </Field>
          <Field label={t("setup.agents.saveTo")}>
            <fieldset className="segmented">
              <legend className="sr-only">{t("setup.agents.saveTo")}</legend>
              {(["project", "user"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={draft.scope === s ? "active" : undefined}
                  aria-pressed={draft.scope === s}
                  title={where(s)}
                  onClick={() => set({ scope: s })}
                >
                  {s === "project" ? t("setup.agents.thisProject") : t("setup.agents.allMyProjects")}
                </button>
              ))}
            </fieldset>
          </Field>
        </div>
      )}
      <Field label={t("setup.agents.name")} help={t("setup.agents.nameHelp", { dir: where(draft.scope) })}>
        <input
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder={t("setup.agents.namePlaceholder")}
        />
      </Field>
      <Field label={t("setup.agents.description")} help={t("setup.agents.descriptionHelp")}>
        <textarea rows={2} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={isAutoAgent(draft.description)}
          onChange={(e) => set({ description: withAutoWording(draft.description, e.target.checked) })}
        />
        <span>
          {t("setup.agents.autoCheck")} <span className="muted">{t("setup.agents.autoCheckNote")}</span>
        </span>
      </label>
      <Field label={t("setup.agents.model")}>
        <Select
          label={t("setup.agents.model")}
          value={draft.model}
          options={modelOptions}
          onChange={(model) => set({ model })}
        />
      </Field>
      <fieldset className="tool-picker">
        <legend className="field-label">{t("setup.agents.tools")}</legend>
        <div className="segmented">
          <button
            type="button"
            className={draft.limited ? undefined : "active"}
            aria-pressed={!draft.limited}
            onClick={() => set({ limited: false })}
          >
            {t("setup.agents.allTools")}
          </button>
          <button
            type="button"
            className={draft.limited ? "active" : undefined}
            aria-pressed={draft.limited}
            onClick={() => set({ limited: true })}
          >
            {t("setup.agents.onlyThese")}
          </button>
        </div>
        {draft.limited && (
          <>
            <div className="tool-groups">
              {(Object.keys(KNOWN_TOOLS) as (keyof typeof KNOWN_TOOLS)[]).map((g) => (
                <div key={g} className="tool-group-box">
                  <span className="muted">{GROUPS[g]}</span>
                  {KNOWN_TOOLS[g].map((tool) => (
                    <label key={tool} className="check">
                      <input
                        type="checkbox"
                        checked={draft.tools.split(",").some((x) => x.trim() === tool)}
                        onChange={(e) => set({ tools: toggleTool(draft.tools, tool, e.target.checked) })}
                      />
                      <span>{tool}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <Field label={t("setup.agents.mcpTools")} help={t("setup.agents.mcpToolsHelp")}>
              <input
                value={others}
                onChange={(e) => setOthers(e.target.value)}
                onBlur={() => set({ tools: withOtherTools(draft.tools, others) })}
                placeholder={t("setup.agents.mcpToolsPlaceholder")}
              />
            </Field>
          </>
        )}
        <span className="field-help">
          {draft.limited ? t("setup.agents.limitedHelp") : t("setup.agents.allToolsHelp")}
        </span>
      </fieldset>
      <Field label={t("setup.agents.prompt")} help={t("setup.agents.promptHelp")}>
        <textarea rows={8} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} />
      </Field>
      {problems.length > 0 && (
        <ul className="agent-problems" aria-live="polite">
          {problems.map((p) => (
            <li key={p} className="warn">
              {p}
            </li>
          ))}
        </ul>
      )}
      <div className="agent-form-actions">
        <button type="submit" className="primary small" disabled={problems.length > 0 || saving}>
          {saving ? t("setup.agents.saving") : isNew ? t("setup.agents.createAgent") : t("setup.agents.saveAgent")}
        </button>
        <button type="button" className="secondary small" onClick={onCancel}>
          {t("setup.agents.cancel")}
        </button>
      </div>
    </form>
  );
}
