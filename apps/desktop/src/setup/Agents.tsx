import { type AgentDefinition, type AgentInput, isAutoAgent, withAutoWording } from "@agentchainer/protocol";
import { Bot, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { request } from "../sidecar.ts";
import { Field } from "../ui/Field.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { EmptyState } from "../ui/Section.tsx";
import { Select } from "../ui/Select.tsx";

const MODELS = [
  { value: "", label: "Default", hint: "The CLI's default for subagents" },
  { value: "inherit", label: "Same as the session" },
  { value: "haiku", label: "Haiku" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];

/** The form's fields; whether the agent is auto is read from the description's wording. */
type Draft = {
  previous?: string;
  name: string;
  description: string;
  tools: string;
  model: string;
  prompt: string;
};

const blank: Draft = { name: "", description: "", tools: "", model: "", prompt: "" };
const draftOf = (a: AgentDefinition): Draft => ({
  previous: a.file.split("/").pop()?.replace(/\.md$/, "") ?? a.name,
  name: a.name,
  description: a.description,
  tools: a.tools ?? "",
  model: a.model ?? "",
  prompt: a.prompt,
});

/**
 * The agent library (M4-06) as a section of Workspace settings: the project's subagents (`.claude/agents/`), which can
 * be created, edited and deleted, and the user's own (`~/.claude/agents/`), listed read-only. Each change is a run in
 * History, so it can be rolled back; sessions pick it up when they start.
 */
export function Agents({ cwd, confirm, onChanged }: { cwd: string; confirm: Confirm; onChanged: () => void }) {
  const [agents, setAgents] = useState<AgentDefinition[] | null>(null);
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
  }, [load]);

  async function save() {
    if (!draft) return;
    const agent: AgentInput = {
      name: draft.name.trim(),
      description: draft.description,
      prompt: draft.prompt,
      auto: isAutoAgent(draft.description),
      ...(draft.tools.trim() ? { tools: draft.tools.trim() } : {}),
      ...(draft.model ? { model: draft.model } : {}),
    };
    setSaving(true);
    try {
      await request("agents.save", {
        cwd,
        agent,
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
          <code>{a.file}</code> is deleted. You can bring it back from History with Roll back.
          {a.role ? " The setup plan will offer to install this task role again." : ""}
        </p>
      ),
      confirmLabel: "Delete agent",
    });
    if (!ok) return;
    try {
      await request("agents.delete", { cwd, name });
      onChanged();
      await load();
    } catch (err) {
      setError(String(err));
    }
  }

  const project = agents?.filter((a) => a.scope === "project") ?? [];
  const user = agents?.filter((a) => a.scope === "user") ?? [];
  return (
    <div className="setup-scroll">
      <p className="muted">
        Subagents Claude can hand work to. <strong>Auto</strong> ones say “use proactively”, so Claude may start them on
        its own when a task fits; <strong>manual</strong> ones run when you or a prompt ask for them. Changes apply to
        sessions started afterwards, and each one can be rolled back in History.
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
              <button type="button" className="secondary small" onClick={() => setDraft(blank)}>
                <Plus size={13} />
                New agent
              </button>
            )}
          </div>
          {draft && draft.previous === undefined && (
            <AgentForm
              draft={draft}
              saving={saving}
              onChange={setDraft}
              onSave={save}
              onCancel={() => setDraft(null)}
            />
          )}
          {project.length === 0 && !draft && <EmptyState icon={<Bot size={14} />}>No project agents yet.</EmptyState>}
          {project.map((a) =>
            draft?.previous !== undefined && draft.previous === draftOf(a).previous ? (
              <AgentForm
                key={a.file}
                draft={draft}
                saving={saving}
                onChange={setDraft}
                onSave={save}
                onCancel={() => setDraft(null)}
              />
            ) : (
              <AgentRow
                key={a.file}
                agent={a}
                {...(a.error ? {} : { onEdit: () => setDraft(draftOf(a)) })}
                onDelete={() => void remove(a)}
              />
            ),
          )}
        </section>
      )}

      {user.length > 0 && (
        <section className="card agents-card">
          <div className="card-title">
            <h2>Yours, in every project</h2>
            <code className="muted">~/.claude/agents/</code>
          </div>
          <p className="field-help">Your own agents, listed here to read. Edit them in that folder.</p>
          {user.map((a) => (
            <AgentRow key={a.file} agent={a} />
          ))}
        </section>
      )}
    </div>
  );
}

function AgentRow({
  agent: a,
  onEdit,
  onDelete,
}: {
  agent: AgentDefinition;
  onEdit?: () => void;
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
          <IconButton label="Edit agent" onClick={onEdit}>
            <Pencil size={13} />
          </IconButton>
        )}
        {onDelete && (
          <IconButton label="Delete agent" onClick={onDelete}>
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
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft;
  saving: boolean;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const models =
    draft.model && !MODELS.some((m) => m.value === draft.model)
      ? [...MODELS, { value: draft.model, label: draft.model }]
      : MODELS;
  const ready = /^[a-z0-9][a-z0-9-]{0,63}$/.test(draft.name.trim()) && draft.description.trim() && draft.prompt.trim();
  return (
    <form
      className="agent-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !saving) onSave();
      }}
    >
      <Field label="Name" help="Lowercase letters, digits and hyphens. It is also the file name.">
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
      <div className="field-row">
        <Field label="Model">
          <Select label="Model" value={draft.model} options={models} onChange={(model) => set({ model })} />
        </Field>
        <Field label="Tools" help="Comma-separated, e.g. Read, Grep, Glob. Empty for all tools.">
          <input value={draft.tools} onChange={(e) => set({ tools: e.target.value })} placeholder="All tools" />
        </Field>
      </div>
      <Field label="Prompt" help="The agent's system prompt.">
        <textarea rows={8} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} />
      </Field>
      <div className="agent-form-actions">
        <button type="submit" className="primary small" disabled={!ready || saving}>
          {saving ? "Saving…" : draft.previous === undefined ? "Create agent" : "Save agent"}
        </button>
        <button type="button" className="secondary small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
