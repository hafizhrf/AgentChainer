import type {
  AgentEvent,
  Effort,
  FleetItem,
  ModelOption,
  PermissionMode,
  PermissionRequest,
  SlashCommand,
} from "@agentchainer/protocol";
import { PERMISSION_MODES } from "@agentchainer/protocol";
import { percent, usd } from "./i18n/format.ts";
import { t } from "./i18n/index.ts";
import { applyEvent, type Item } from "./transcript.ts";

/**
 * One live session per tab (M1-06/M1-08). Tabs are keyed by the SDK session id, which every notification carries,
 * so events from background tabs land in the right transcript.
 */
export type Tab = {
  sessionId: string;
  cwd: string;
  /** A multi-folder workspace's other folders the session also reaches (M8-01). */
  folders?: string[];
  title: string;
  /** The title is still the placeholder a new chat starts with: the first message sent names the tab. */
  untitled?: boolean;
  /** The model the CLI reports (full id), and the alias picked in the UI ("" = default). */
  model?: string;
  modelAlias: string;
  effort: Effort | null;
  /** The session's spend cap (`maxBudgetUsd`), fixed when it started. */
  budgetUsd: number | null;
  claudeCodeVersion?: string;
  /** Slash commands and skills for the composer's `/` menu, with descriptions once the session sends them (UX-12). */
  slashCommands: SlashCommand[];
  /** The models the CLI offers, as its `/model` names them (UX-12); empty until the session sends them. */
  models: ModelOption[];
  /** How full the context window was after the last turn (UX-12); null until a turn reports it. */
  context: Omit<Extract<AgentEvent, { type: "context.usage" }>, "type"> | null;
  /** A Team chat's worker (M8-03): the supervisor's session id, and what the worker may do. */
  parentId?: string;
  access?: "read" | "write";
  /** The agent profile the session runs as (M8-04): its prompt, model and only its tools. */
  profile?: string;
  /** A Team chat (M8-03): what it and its workers spent together, against its one cap. */
  team?: { capUsd: number; spentUsd: number; stopped: boolean };
  /** What the composer starts as (UX-13): New in Task mode opens a chat whose composer makes a task. */
  kind?: "chat" | "task";
  /** Set while Claude switched itself to plan mode (UX-12): the mode to go back to. */
  planSwitch: { previous: PermissionMode } | null;
  items: Item[];
  running: boolean;
  /** How the last turn ended (`success`, `error_max_budget_usd`, …); queued messages only go out after a success. */
  lastSubtype: string | null;
  /** The live session is gone (runtime restart, or the CLI exited). The tab stays so it can be resumed. */
  ended: boolean;
  mode: PermissionMode;
  /** Pending tool approvals, oldest first. */
  permissions: PermissionRequest[];
  /** How long each tool call waited for an approval, for the timeline (M4-04). Live sessions only. */
  waits: Wait[];
  /** Subagents and shells still working in the background (M4-07); the session is busy while there are any. */
  background: BackgroundTask[];
  cost: Cost;
};

export type BackgroundTask = Extract<AgentEvent, { type: "background.changed" }>["tasks"][number];

/** A tool call's wait for an approval, from the request to its answer (epoch ms); `end` is unset while it waits. */
export type Wait = { toolUseId: string; requestId: string; start: number; end?: number };

type Tokens = { input: number; output: number };

/**
 * Cost estimates (ARCHITECTURE §5.3). The SDK reports running session totals, so a turn's cost and tokens are the
 * difference between two totals. `null` means unknown: a resumed session's first total also includes earlier turns.
 */
export type Cost = {
  totalUsd: number | null;
  lastUsd: number | null;
  lastMs: number;
  totalTokens: Tokens | null;
  lastTokens: Tokens | null;
};

export const asMode = (value: string | null | undefined): PermissionMode =>
  PERMISSION_MODES.find((m) => m === value) ?? "default";

/** A session with nothing sent yet (UX-06): its composer sits in the middle with starter prompts below. */
export const isFresh = (tab: Tab) => !tab.running && !tab.ended && !tab.items.some((i) => i.kind === "user");

export function newTab(
  sessionId: string,
  cwd: string,
  options: {
    title: string;
    /** `title` is a placeholder, replaced by the first message sent. */
    untitled?: boolean;
    mode: PermissionMode;
    items?: Item[];
    resumed?: boolean;
    modelAlias?: string;
    effort?: Effort | null;
    budgetUsd?: number | null;
    folders?: string[];
    parentId?: string;
    access?: "read" | "write";
    profile?: string;
    /** A Team chat's cap (M8-03). */
    teamCapUsd?: number;
  },
): Tab {
  return {
    sessionId,
    cwd,
    ...(options.folders?.length ? { folders: options.folders } : {}),
    ...(options.parentId ? { parentId: options.parentId } : {}),
    ...(options.access ? { access: options.access } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.teamCapUsd ? { team: { capUsd: options.teamCapUsd, spentUsd: 0, stopped: false } } : {}),
    title: options.title,
    ...(options.untitled ? { untitled: true } : {}),
    modelAlias: options.modelAlias ?? "",
    effort: options.effort ?? null,
    budgetUsd: options.budgetUsd ?? null,
    slashCommands: [],
    models: [],
    context: null,
    planSwitch: null,
    items: options.items ?? [],
    running: false,
    lastSubtype: null,
    ended: false,
    mode: options.mode,
    permissions: [],
    waits: [],
    background: [],
    cost: {
      totalUsd: options.resumed ? null : 0,
      lastUsd: null,
      lastMs: 0,
      totalTokens: options.resumed ? null : { input: 0, output: 0 },
      lastTokens: null,
    },
  };
}

/** Applies one agent event to its tab. `now` is passed for live events (tool timing). */
export function tabEvent(tab: Tab, e: AgentEvent, now?: number): Tab {
  switch (e.type) {
    case "session.started":
      // Arrives at the start of every turn (spike S2), so this must stay idempotent.
      return {
        ...tab,
        model: e.model,
        claudeCodeVersion: e.claudeCodeVersion,
        mode: asMode(e.permissionMode),
        ...(asMode(e.permissionMode) !== "plan" ? { planSwitch: null } : {}),
        // Names only, until the session sends the described list (`commands.changed`), which then wins.
        ...(e.slashCommands && !tab.slashCommands.some((c) => c.description)
          ? { slashCommands: e.slashCommands.map((name) => ({ name, description: "", argumentHint: "" })) }
          : {}),
      };
    case "commands.changed":
      return { ...tab, slashCommands: e.commands };
    case "models.changed":
      return { ...tab, models: e.models };
    case "context.usage": {
      const { type: _type, ...context } = e;
      return { ...tab, context };
    }
    case "tool.started":
      // Claude switching itself to plan mode (UX-12): the sidecar already allowed it; remember where it came from.
      if (e.name === "EnterPlanMode" && e.parentToolUseId === null && tab.mode !== "plan") {
        return { ...tab, mode: "plan", planSwitch: { previous: tab.mode }, items: applyEvent(tab.items, e, now) };
      }
      return { ...tab, items: applyEvent(tab.items, e, now) };
    case "turn.completed": {
      const totalTokens = e.usage
        ? {
            input: e.usage.inputTokens + e.usage.cacheReadTokens + e.usage.cacheCreationTokens,
            output: e.usage.outputTokens,
          }
        : null;
      const prev = tab.cost.totalTokens;
      return {
        ...tab,
        running: false,
        // A finished turn takes its approvals with it: after a Stop, the pending ones can't be answered any more.
        permissions: [],
        lastSubtype: e.subtype,
        items: applyEvent(tab.items, e, now),
        waits: closeWaits(tab.waits, now),
        cost: {
          totalUsd: e.totalCostUsd,
          lastUsd: tab.cost.totalUsd === null ? null : Math.max(0, e.totalCostUsd - tab.cost.totalUsd),
          lastMs: e.durationMs,
          totalTokens,
          lastTokens:
            totalTokens && prev
              ? {
                  input: Math.max(0, totalTokens.input - prev.input),
                  output: Math.max(0, totalTokens.output - prev.output),
                }
              : null,
        },
      };
    }
    case "background.changed":
      return { ...tab, background: e.tasks };
    // The sidecar starts these turns itself (M8-03): a worker's assignment, and a supervisor's delivered reports.
    case "user.message":
    case "worker.message":
      return { ...tab, running: true, items: applyEvent(tab.items, e, now) };
    case "team.budget":
      return { ...tab, team: { capUsd: e.capUsd, spentUsd: e.spentUsd, stopped: e.stopped } };
    case "turn.started":
      return { ...tab, running: true, items: applyEvent(tab.items, e, now) };
    case "error":
      return {
        ...tab,
        running: false,
        lastSubtype: "error",
        items: applyEvent(tab.items, e, now),
        waits: closeWaits(tab.waits, now),
      };
    default:
      return { ...tab, items: applyEvent(tab.items, e, now) };
  }
}

/** A tool call asks for an approval: queue it, and start its wait. */
export function permissionAsked(tab: Tab, req: PermissionRequest, now: number): Tab {
  return {
    ...tab,
    permissions: [...tab.permissions, req],
    waits: [...tab.waits, { toolUseId: req.toolUseId, requestId: req.requestId, start: now }],
  };
}

/** An approval was answered: drop it from the queue, and end its wait. */
export function permissionAnswered(tab: Tab, requestId: string, now: number): Tab {
  return {
    ...tab,
    permissions: tab.permissions.filter((p) => p.requestId !== requestId),
    waits: tab.waits.map((w) => (w.requestId === requestId && w.end === undefined ? { ...w, end: now } : w)),
  };
}

/** A turn that ends, or a session that dies, ends every wait still open. */
export function closeWaits(waits: Wait[], now: number | undefined): Wait[] {
  if (now === undefined || waits.every((w) => w.end !== undefined)) return waits;
  return waits.map((w) => (w.end === undefined ? { ...w, end: now } : w));
}

/**
 * Chats the runtime still runs that have no tab (M1-36): a WebView reload wipes the tabs but not the sidecar's
 * sessions. A task's steps and a Team's workers have owners of their own, and an ended session needs no tab.
 */
export function orphanChats(items: FleetItem[], tabs: Pick<Tab, "sessionId">[]): FleetItem[] {
  const open = new Set(tabs.map((x) => x.sessionId));
  return items.filter((i) => !i.task && !i.parentId && i.status !== "ended" && !open.has(i.sessionId));
}

export function updateTab(tabs: Tab[], sessionId: string, fn: (tab: Tab) => Tab): Tab[] {
  return tabs.map((t) => (t.sessionId === sessionId ? fn(t) : t));
}

/** "my-app" for "/Users/me/projects/my-app". */
export function folderName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir;
}

/**
 * ≈USD for a subagent's tokens (design §11): the session's cost per token so far, from the SDK's own totals, times the
 * agent's tokens. Cache reads and the models used are in that rate, so no price table is needed; it's still an
 * estimate, and the agents' figures needn't add up to the session's. `null` until a turn has reported its totals.
 */
export function agentUsd(cost: Cost, tokens: number | undefined): number | null {
  const all = cost.totalTokens ? cost.totalTokens.input + cost.totalTokens.output : 0;
  if (tokens === undefined || cost.totalUsd === null || all === 0) return null;
  return (cost.totalUsd / all) * tokens;
}

/** The budget warning (M1-32): at 80% of the cap, for sessions whose whole spend is known. */
export function budgetWarning(tab: Tab): string | null {
  if (tab.budgetUsd === null || tab.cost.totalUsd === null) return null;
  const cap = usd(tab.budgetUsd, 2);
  if (tab.lastSubtype === "error_max_budget_usd") return t("session.budget.reached", { cap });
  const share = tab.cost.totalUsd / tab.budgetUsd;
  return share >= 0.8 ? t("session.budget.warning", { percent: percent(share), cap }) : null;
}
