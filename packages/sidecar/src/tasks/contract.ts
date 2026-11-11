import {
  type CriterionCheck,
  CriterionCheckSchema,
  GATE_KINDS,
  type GateKind,
  type TaskContract,
  type WorkspaceProfile,
} from "@agentchainer/protocol";
import type { HookCallback, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { generatorHook } from "../bootstrap/generate.ts";
import { guarded } from "../bootstrap/workspace-guard.ts";
import { t } from "../i18n/index.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import { smokeCommand } from "./gates.ts";

/**
 * Drafting the task contract (M3-02, planner.md §3): a read-only session reads the repository and answers with
 * structured output. It can use Read, Grep and Glob only, the generators' hook keeps it inside the workspace, and the
 * workspace guard reverts anything that changed anyway. The user edits the draft and approves it.
 *
 * It can ask first (UX-24): once, through `AskUserQuestion`, when the request leaves open a decision that changes the
 * work. The questions go to the task page as cards, and the answers come back into the draft and onto the task.
 */

/** Gates the workspace has a command for: the profile's, plus `smoke` when `scripts/smoke.*` exists (M3-08). */
export function availableGates(profile: WorkspaceProfile, root?: string): GateKind[] {
  return GATE_KINDS.filter((kind) =>
    kind === "smoke"
      ? root !== undefined && smokeCommand(root) !== null
      : profile.packages.some((p) => p.commands[kind]),
  );
}

const CHECKS = ["review", "manual", ...GATE_KINDS.map((k) => `gate:${k}`)];

export const DRAFT_JSON_SCHEMA = {
  type: "object",
  properties: {
    objective: { type: "string" },
    acceptanceCriteria: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, check: { type: "string", enum: CHECKS } },
        required: ["text", "check"],
        additionalProperties: false,
      },
    },
    constraints: { type: "array", items: { type: "string" } },
    outOfScope: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    affectedAreas: {
      type: "array",
      items: { type: "string", description: "One workspace-relative path or glob, with no notes or alternatives" },
    },
    openQuestions: { type: "array", items: { type: "string" } },
  },
  required: ["objective", "acceptanceCriteria", "constraints", "outOfScope", "risks", "affectedAreas", "openQuestions"],
  additionalProperties: false,
};

const GUIDE = `You draft task contracts for AgentChainer. A contract says what will be done and what counts as done, before
any code changes. Read the repository to ground it (you can only read; you can't change anything), then answer with
the structured output:
- objective: the outcome in one or two sentences, not the steps.
- acceptanceCriteria: two to six concrete statements of done. Set each one's check:
  - "gate:<kind>" when a project check proves it. Only the gates listed as available exist. Prefer gate:test for
    behavior when tests exist: the criterion then means a test covers it and passes.
  - "review" when a reviewer can judge it from the diff.
  - "manual" when only the user can check it, such as how something looks or behaves in production.
- constraints: limits the work must respect, only those the request or the repository implies.
- outOfScope: related work this task won't do.
- risks: what could go wrong, such as breaking callers, losing data or weakening security.
- affectedAreas: workspace-relative paths or globs you expect to change, from what you read. One path per item and
  nothing else: no notes such as "(new)", no alternatives such as "a.ts or b.ts". New files are fine.
- openQuestions: decisions the request leaves open that change the work. Empty when the request is clear. Don't ask
  what the repository answers.
Keep every item short. Don't plan the implementation.`;

/** The detected packages and the gates that exist, for a drafting or split prompt. */
export function workspaceLines(profile: WorkspaceProfile, gates: GateKind[]): string[] {
  const packages = profile.packages.map((p) => {
    const commands = Object.keys(p.commands).join(", ") || "none";
    return `- ${p.path} (${p.stack}${p.frameworks.length ? `, ${p.frameworks.join(", ")}` : ""}): commands ${commands}`;
  });
  return [
    "Workspace (detected by AgentChainer):",
    ...(packages.length ? packages : ["- no packages detected"]),
    `Available gates: ${gates.length ? gates.join(", ") : "none"}.`,
  ];
}

/** A question the drafter asked and the person's answer (UX-24). */
export type Clarification = { question: string; answer: string };

/**
 * Puts the drafter's `AskUserQuestion` to the person: the answers by question text, or null when they skipped them
 * or the draft stopped.
 */
export type AskQuestions = (
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, string> | null>;

/** The SDK's tool for asking the person, with choices. */
const ASK_TOOL = "AskUserQuestion";

/** The person skipped the questions, or the draft stopped waiting. */
const SKIPPED =
  "The person skipped these questions. Draft with what you have, and list what's still open in openQuestions.";
/** Drafting asks one round of questions (owner's choice, UX-24). */
const ASKED_ONCE = "You've asked once already: draft now, and list what's still open in openQuestions.";

/** Added to the guide when drafting can ask (UX-24). */
const ASK_GUIDE = `

Ask before you draft. When the request leaves open a decision that changes the work and the repository doesn't answer
it (anything you would otherwise put in openQuestions), ask the person about it first, in one AskUserQuestion call: at
most 4 questions, each with 2 to 4 short options; the person can also type an answer of their own. Don't ask what the
request, the repository or the settled answers already say, and don't ask for permission to read. Then draft with
their answers: openQuestions keeps only what's still open after they answered. When nothing is open, draft straight
away.`;

/** What else drafting reads (UX-13): the chat a task came from, and, when redrafting, the contract and the reply. */
export type DraftExtra = {
  context?: string;
  current?: TaskContract;
  feedback?: string;
  /** What the person already answered to the drafter's questions (UX-24): a redraft doesn't ask again. */
  settled?: Clarification[];
  /** A multi-folder workspace's other folders (M8-01), which drafting reads and names areas in. */
  folders?: { name: string; path: string }[];
};

export function draftPrompt(
  request: string,
  profile: WorkspaceProfile,
  gates: GateKind[],
  extra: DraftExtra = {},
): string {
  return [
    `Request: ${request}`,
    ...(extra.context
      ? ["", "The chat this task comes from (its last messages; the request above is what to do):", extra.context]
      : []),
    ...(extra.current
      ? [
          "",
          "The current draft of the contract, which the person replied to:",
          JSON.stringify({ ...extra.current, task: undefined, approvedAt: undefined }),
        ]
      : []),
    ...(extra.feedback ? ["", `The person's reply: ${extra.feedback}`, "Draft the contract again, following it."] : []),
    ...(extra.settled?.length
      ? [
          "",
          "Already settled with the person (don't ask these again):",
          ...extra.settled.map((c) => `- ${c.question} → ${c.answer}`),
        ]
      : []),
    ...(extra.folders?.length
      ? [
          "",
          "This workspace has other folders too, which you can read:",
          ...extra.folders.map((f) => `- ${f.name}: ${f.path}`),
          `Name an affected area in one of them with the folder's name and a colon, e.g. \`${extra.folders[0]?.name}:src/index.ts\`; an area without a prefix is in this folder.`,
        ]
      : []),
    "",
    ...workspaceLines(profile, gates),
  ].join("\n");
}

const MAX = { criteria: 30, list: 30, areas: 50, questions: 20, line: 2000, area: 500, objective: 4000 };

function lines(value: unknown, max: number, maxLength = MAX.line): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const text = typeof v === "string" ? v.trim().slice(0, maxLength) : "";
    if (text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, max);
}

/**
 * The paths in one drafted area. Models annotate them anyway ("index.html (new)", "a.ts or b.ts", backticks); the
 * notes are dropped and alternatives split, so the scope signal measures paths, not prose.
 */
export function cleanAreas(entry: string): string[] {
  const text = entry.replace(/`/g, "").replace(/\s+\(.*$/, "");
  return text
    .split(/\s*,\s*|\s+or\s+|\s+and\s+/)
    .map(cleanArea)
    .filter((a): a is string => a !== null);
}

/** A workspace-relative, `/`-separated area; null for anything absolute or leaving the workspace. */
export function cleanArea(area: string): string | null {
  const a = area.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!a || a.startsWith("/") || /^[a-zA-Z]:/.test(a) || a.split("/").includes("..")) return null;
  return a.slice(0, MAX.area);
}

/**
 * Turns a draft (the model's output, or the user's edits) into a valid contract: trimmed, deduplicated and capped;
 * criteria numbered c1…cn; a check that's missing, unknown or names a gate the profile lacks becomes `manual`, so it
 * can't silently count as proved; areas outside the workspace are dropped.
 */
export function normalizeContract(request: string, draft: unknown, gates: GateKind[]): TaskContract {
  const d = (draft && typeof draft === "object" ? draft : {}) as Record<string, unknown>;
  const criteria = Array.isArray(d.acceptanceCriteria) ? d.acceptanceCriteria : [];
  const acceptanceCriteria = criteria
    .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>) : {}))
    .map((c) => ({ text: typeof c.text === "string" ? c.text.trim().slice(0, MAX.line) : "", check: c.check }))
    .filter((c) => c.text)
    .slice(0, MAX.criteria)
    .map((c, i) => {
      const parsed = CriterionCheckSchema.safeParse(c.check);
      let check: CriterionCheck = parsed.success ? parsed.data : "manual";
      if (check.startsWith("gate:") && !gates.includes(check.slice(5) as GateKind)) check = "manual";
      return { id: `c${i + 1}`, text: c.text, check };
    });
  const areas = lines(d.affectedAreas, MAX.areas, MAX.area).flatMap(cleanAreas);
  return {
    task: request,
    objective: typeof d.objective === "string" ? d.objective.trim().slice(0, MAX.objective) : "",
    acceptanceCriteria,
    constraints: lines(d.constraints, MAX.list),
    outOfScope: lines(d.outOfScope, MAX.list),
    risks: lines(d.risks, MAX.list),
    affectedAreas: [...new Set(areas)].slice(0, MAX.areas),
    openQuestions: lines(d.openQuestions, MAX.questions),
  };
}

export type DraftOptions = {
  model?: string;
  maxBudgetUsd?: number;
  abortController?: AbortController;
  /** Context, or the reply to redraft from (UX-13). */
  extra?: DraftExtra;
  /** Each SDK message, so drafting can be shown as it reads the project (UX-13). */
  onMessage?: (m: SDKMessage) => void;
  /** Lets drafting ask the person first (UX-24); without it, drafting can't ask. */
  ask?: AskQuestions;
};

/** The generators' hook, letting `AskUserQuestion` through when drafting can ask. */
function draftHook(root: string, folders: string[], canAsk: boolean): HookCallback {
  const hook = generatorHook(root, [], folders);
  if (!canAsk) return hook;
  return async (input, toolUseId, options) =>
    input.hook_event_name === "PreToolUse" && input.tool_name === ASK_TOOL ? {} : hook(input, toolUseId, options);
}

/** Drafts the contract. The cost is returned with the result or the error, so a failed draft is still accounted. */
export async function draftContract(
  sdk: AgentSdkModule,
  claudePath: string,
  root: string,
  request: string,
  profile: WorkspaceProfile,
  opts: DraftOptions = {},
): Promise<{ contract: TaskContract | null; error?: string; costUsd: number; clarifications: Clarification[] }> {
  const gates = availableGates(profile, root);
  const folders = opts.extra?.folders?.map((f) => f.path) ?? [];
  let costUsd = 0;
  const ask = opts.ask;
  let asked = false;
  const clarifications: Clarification[] = [];
  const { result } = await guarded(root, async () => {
    const q = sdk.query({
      prompt: draftPrompt(request, profile, gates, opts.extra),
      options: {
        cwd: root,
        pathToClaudeCodeExecutable: claudePath,
        ...(opts.model ? { model: opts.model } : {}),
        tools: ["Read", "Grep", "Glob", ...(ask ? [ASK_TOOL] : [])],
        // Isolated from the user's and the project's settings: no hooks, plugins or MCP servers run here.
        settingSources: [],
        persistSession: false,
        maxTurns: 30,
        maxBudgetUsd: opts.maxBudgetUsd ?? 0.5,
        systemPrompt: { type: "preset", preset: "claude_code", append: ask ? GUIDE + ASK_GUIDE : GUIDE },
        outputFormat: { type: "json_schema", schema: DRAFT_JSON_SCHEMA },
        hooks: { PreToolUse: [{ hooks: [draftHook(root, folders, Boolean(ask))] }] },
        ...(folders.length ? { additionalDirectories: folders } : {}),
        // The hook above already decided; anything that reaches here is allowed, except a question, which waits for
        // the person's answers (once).
        canUseTool: async (tool, input, { signal }) => {
          if (tool !== ASK_TOOL || !ask) return { behavior: "allow", updatedInput: input };
          if (asked) return { behavior: "deny", message: ASKED_ONCE };
          asked = true;
          const answers = await ask(input, signal);
          if (!answers) return { behavior: "deny", message: SKIPPED };
          for (const [question, answer] of Object.entries(answers)) clarifications.push({ question, answer });
          return { behavior: "allow", updatedInput: { ...input, answers } };
        },
        ...(opts.abortController ? { abortController: opts.abortController } : {}),
      },
    });
    for await (const m of q) {
      opts.onMessage?.(m);
      if (m.type !== "result") continue;
      costUsd += m.total_cost_usd;
      if (m.subtype !== "success")
        return { contract: null, error: t("tasks.contract.draftingStopped", { reason: m.subtype }) };
      return { contract: normalizeContract(request, m.structured_output, gates) };
    }
    return { contract: null, error: t("tasks.contract.noResult") };
  });
  return { ...result, costUsd, clarifications };
}
