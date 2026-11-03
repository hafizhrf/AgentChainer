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

const MODELS = [
  { value: "", label: "Default", hint: "The CLI's default for subagents" },
  { value: "inherit", label: "Same as the session" },
  { value: "haiku", label: "Haiku" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];

const GROUPS: Record<keyof typeof KNOWN_TOOLS, string> = {
  read: "Read",
  edit: "Edit",
  shell: "Shell",
  web: "Web",
  other: "Other",
};

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
        title: `Save ${draft.name} for all your projects?`,
        body: (
          <p>
            It's written to <code>~/.claude/agents/{draft.name}.md</code>, outside this workspace, so History can't roll
            it back. You can still edit or delete it here.
          </p>
        ),
        confirmLabel: "Save agent",
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
      title: `Delete ${a.name}?`,
      body: (
        <p>
          <code>{a.file}</code> is deleted.{" "}
          {a.scope === "user"
            ? "It's your own agent, outside this workspace, so History can't bring it back."
            : "You can bring it back from History with Roll back."}
          {a.role ? " The setup plan will offer to install this task role again." : ""}
        </p>
      ),
      confirmLabel: "Delete agent",
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
        Agents Claude can hand work to, and profiles to run a chat or a Team worker as. <strong>Auto</strong> ones say
        “use proactively”, so Claude may start them on its own when a task fits; <strong>manual</strong> ones run when
        you or a prompt ask for them. When the app runs one, only the tools it lists are there. Changes apply to
        sessions started afterwards.
      </p>
      {error && <p className="warn">{error}</p>}
      {!agents && !error && <p className="muted">Loading…</p>}

      {agents && (
        <section className="card agents-card">
          <div className="card-title">
            <h2>This project</h2>
            <code className="muted">.claude/agents/</code>
            <span className="grow" />
            {!draft && (
              <button type="button" className="secondary small" onClick={() => setDraft(blankDraft())}>
                <Plus size={13} />
                New agent
              </button>
            )}
          </div>
          <p className="field-help">Each change is a run in History, so it can be rolled back.</p>
          {draft && draft.previous === undefined && form(draft)}
          {project.length === 0 && !(draft && draft.previous === undefined) && (
            <EmptyState icon={<Bot size={14} />}>No project agents yet.</EmptyState>
          )}
          {rows(project)}
        </section>
      )}

      {agents && (
        <section className="card agents-card">
          <div className="card-title">
            <h2>Yours, in every project</h2>
            <code className="muted">~/.claude/agents/</code>
          </div>
          <p className="field-help">
            Your own agents. They're outside this workspace, so History doesn't cover them: a change is saved in place.
          </p>
          {user.length === 0 && (
            <EmptyState icon={<Bot size={14} />}>
              None yet. To add one, pick “All my projects” in a new agent's form.
            </EmptyState>
          )}
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
        {!a.error && <span className={`chip${a.auto ? " on" : ""}`}>{a.auto ? "Auto" : "Manual"}</span>}
        {a.role && <span className="chip">Task role</span>}
        {a.model && <span className="chip">{a.model}</span>}
        <span className="grow" />
        {onEdit && (
          <IconButton label={`Edit ${a.name}`} onClick={onEdit}>
            <Pencil size={13} />
          </IconButton>
        )}
        {onClone && (
          <IconButton label={`Clone ${a.name}`} onClick={onClone}>
            <Copy size={13} />
          </IconButton>
        )}
        {onDelete && (
          <IconButton label={`Delete ${a.name}`} onClick={onDelete}>
            <Trash2 size={13} />
          </IconButton>
        )}
      </div>
      {a.error ? (
        <p className="warn">
          <code>{a.file}</code> can't be read as an agent: {a.error}
        </p>
      ) : (
        <>
          <p className="agent-row-desc">{a.description}</p>
          <p className="field-help">{a.tools ? `Tools: ${a.tools}` : "All tools"}</p>
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
  const models =
    draft.model && !MODELS.some((m) => m.value === draft.model)
      ? [...MODELS, { value: draft.model, label: draft.model }]
      : MODELS;
  const problems = draftProblems(draft, taken);
  const [others, setOthers] = useState(otherTools(draft.tools));
  const [start, setStart] = useState("");
  const starts = [
    { value: "", label: "Blank" },
    ...templates.map((t) => ({
      value: t.id,
      label: `${t.source === "role" ? "Task role" : "Starter"}: ${t.name}`,
      hint: t.description,
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
          <Field label="Start from" help="A shipped task role or a starter fills in the form; nothing is saved yet.">
            <Select
              label="Start from"
              value={start}
              options={starts}
              onChange={(id) => {
                setStart(id);
                const t = templates.find((x) => x.id === id);
                const next = t ? templateDraft(t, draft.scope, allTaken(draft.scope)) : { ...draft };
                onChange(next);
                setOthers(otherTools(next.tools));
              }}
            />
          </Field>
          <Field label="Save to">
            <fieldset className="segmented">
              <legend className="sr-only">Save to</legend>
              {(["project", "user"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={draft.scope === s ? "active" : undefined}
                  aria-pressed={draft.scope === s}
                  title={where(s)}
                  onClick={() => set({ scope: s })}
                >
                  {s === "project" ? "This project" : "All my projects"}
                </button>
              ))}
            </fieldset>
          </Field>
        </div>
      )}
      <Field
        label="Name"
        help={`Lowercase letters, digits and hyphens. It is also the file name, in ${where(draft.scope)}`}
      >
        <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="code-reviewer" />
      </Field>
      <Field label="Description" help="When Claude should use it. Claude reads this to pick an agent.">
        <textarea rows={2} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={isAutoAgent(draft.description)}
          onChange={(e) => set({ description: withAutoWording(draft.description, e.target.checked) })}
        />
        <span>
          Auto: Claude may start it on its own{" "}
          <span className="muted">(adds “Use proactively.” to the description)</span>
        </span>
      </label>
      <Field label="Model">
        <Select label="Model" value={draft.model} options={models} onChange={(model) => set({ model })} />
      </Field>
      <fieldset className="tool-picker">
        <legend className="field-label">Tools</legend>
        <div className="segmented">
          <button
            type="button"
            className={draft.limited ? undefined : "active"}
            aria-pressed={!draft.limited}
            onClick={() => set({ limited: false })}
          >
            All tools
          </button>
          <button
            type="button"
            className={draft.limited ? "active" : undefined}
            aria-pressed={draft.limited}
            onClick={() => set({ limited: true })}
          >
            Only these
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
                        checked={draft.tools.split(",").some((t) => t.trim() === tool)}
                        onChange={(e) => set({ tools: toggleTool(draft.tools, tool, e.target.checked) })}
                      />
                      <span>{tool}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <Field
              label="MCP tools"
              help="Comma-separated: mcp__server for all its tools, or mcp__server__tool. Without any, the agent gets no MCP tools when the app runs it."
            >
              <input
                value={others}
                onChange={(e) => setOthers(e.target.value)}
                onBlur={() => set({ tools: withOtherTools(draft.tools, others) })}
                placeholder="mcp__github__*"
              />
            </Field>
          </>
        )}
        <span className="field-help">
          {draft.limited
            ? "When the app runs this agent (a chat or a Team worker), only these tools are there, still with approvals."
            : "Every tool the session has. Approvals and the guard still apply."}
        </span>
      </fieldset>
      <Field label="Prompt" help="The agent's system prompt.">
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
          {saving ? "Saving…" : isNew ? "Create agent" : "Save agent"}
        </button>
        <button type="button" className="secondary small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
