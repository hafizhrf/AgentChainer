import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hasSecret, type Lesson, type LessonSource } from "@agentchainer/protocol";
import { z } from "zod";
import { AC_DIR, ensureIgnored } from "../ac-dir.ts";
import { applyFileEdits } from "../bootstrap/apply.ts";
import { t } from "../i18n/index.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import type { Evidence } from "./evidence.ts";

/**
 * Lessons from outcomes (M8-06, docs/design/lessons.md): what a finished task's records say Claude should know next
 * time, offered as CLAUDE.md lines the person approves one by one. The signals are found here without a model; one
 * small haiku call words them as rules, and anything CLAUDE.md already says, or that the person dismissed, is dropped.
 */

export type Signal = { source: LessonSource; ref: string; text: string };

const MAX_SIGNALS = 30;
const MAX_TEXT = 300;
const MAX_LESSONS = 5;
const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n)}…` : s);
const tailOf = (s: string) => s.trim().split("\n").slice(-6).join("\n");
const keyOf = (kind: string, pkg: string) => (pkg === "." ? kind : `${kind} (${pkg})`);

/** What the run's records point at, by kind: no model needed. */
export function lessonSignals(e: Evidence): Signal[] {
  const out: Signal[] = [];
  // A gate that failed in one round and passed in a later one, not one that was failing before the task.
  const byGate = new Map<string, Evidence["gates"]["runs"]>();
  for (const g of e.gates.runs) {
    const key = keyOf(g.kind, g.package);
    byGate.set(key, [...(byGate.get(key) ?? []), g]);
  }
  for (const [key, runs] of byGate) {
    if (e.gates.preexisting.includes(key)) continue;
    const sorted = [...runs].sort((a, b) => a.round - b.round);
    const bad = sorted.find((g) => g.exitCode !== 0 || g.timedOut);
    const fixed = bad && sorted.find((g) => g.round > bad.round && g.exitCode === 0 && !g.timedOut);
    if (bad && fixed) {
      out.push({
        source: "gate",
        ref: `gate:${key}`,
        text: clip(`\`${bad.command}\` failed, then passed after a fix:\n${tailOf(bad.tail)}`),
      });
    }
    const rewrote = sorted.find((g) => g.kind === "format" && g.changed?.length);
    if (rewrote) {
      out.push({
        source: "format",
        ref: `format:${key}`,
        text: clip(
          `The formatter rewrote ${rewrote.changed?.length} file(s): ${rewrote.changed?.slice(0, 5).join(", ")}`,
        ),
      });
    }
  }
  for (const [i, f] of (e.review?.findings ?? []).entries()) {
    if (f.severity === "note") continue;
    out.push({
      source: "review",
      ref: `review:${i + 1}`,
      text: clip(`${f.severity}${f.file ? ` in ${f.file}` : ""}: ${f.text}`),
    });
  }
  for (const [i, b] of e.security.guardBlocks.entries()) {
    out.push({
      source: "guard",
      ref: `guard:${i + 1}`,
      text: clip(`${b.tool} \`${b.target}\` was blocked: ${b.reason}`),
    });
  }
  for (const [i, a] of e.security.approvals.entries()) {
    if (a.allowed) continue;
    out.push({
      source: "approval",
      ref: `approval:${i + 1}`,
      text: clip(`The person denied ${a.tool} \`${a.target}\``),
    });
  }
  for (const [i, n] of e.risks.fromImplementer.entries()) {
    out.push({ source: "notes", ref: `notes:${i + 1}`, text: clip(n) });
  }
  return out.slice(0, MAX_SIGNALS);
}

/* ---------- Duplicates ---------- */

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

/**
 * Whether `a` says what one of `known` says: 0.8 of its words are in that line, or 0.8 of that line's are in it. A
 * line of fewer than four words doesn't count the second way, so a short CLAUDE.md line can't swallow every lesson.
 */
export function isDuplicate(a: string, known: string[]): boolean {
  const wa = words(a);
  if (!wa.size) return true;
  return known.some((k) => {
    const wk = words(k);
    if (!wk.size) return false;
    let shared = 0;
    for (const w of wa) if (wk.has(w)) shared++;
    return shared / wa.size >= 0.8 || (wk.size >= 4 && shared / wk.size >= 0.8);
  });
}

/** CLAUDE.md's lines that say something, for comparing a lesson against. */
const linesOf = (md: string) =>
  md
    .split("\n")
    .map((l) => l.replace(/^[-*#>\s]+/, "").trim())
    .filter((l) => l.length > 10);

/* ---------- Storage ---------- */

/** The task's last suggestions, in its folder. */
const suggestionsFile = (root: string, taskId: string) => path.join(root, AC_DIR, "tasks", taskId, "lessons.json");
/** Lessons the person dismissed in this workspace: never offered again. Git ignores it. */
const dismissedFile = (root: string) => path.join(root, AC_DIR, "lessons.json");

const LessonsFileSchema = z.object({
  lessons: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      why: z.string(),
      sources: z.array(z.object({ source: z.string(), ref: z.string(), text: z.string() })),
    }),
  ),
});
const DismissedSchema = z.object({ dismissed: z.array(z.string()) });

function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temp, file);
}

export function storedLessons(root: string, taskId: string): Lesson[] {
  const file = suggestionsFile(root, taskId);
  if (!existsSync(file)) return [];
  try {
    return LessonsFileSchema.parse(JSON.parse(readFileSync(file, "utf8"))).lessons as Lesson[];
  } catch {
    return [];
  }
}

export function dismissedLessons(root: string): string[] {
  const file = dismissedFile(root);
  if (!existsSync(file)) return [];
  try {
    return DismissedSchema.parse(JSON.parse(readFileSync(file, "utf8"))).dismissed;
  } catch {
    return [];
  }
}

/** Remembers these lessons as dismissed, and drops them from the task's suggestions. */
export function dismissLessons(root: string, taskId: string, ids: string[]): Lesson[] {
  const all = storedLessons(root, taskId);
  const gone = all.filter((l) => ids.includes(l.id)).map((l) => l.text);
  ensureIgnored(root, "lessons.json");
  writeJson(dismissedFile(root), { dismissed: [...dismissedLessons(root), ...gone] });
  const kept = all.filter((l) => !ids.includes(l.id));
  writeJson(suggestionsFile(root, taskId), { lessons: kept });
  return kept;
}

/* ---------- CLAUDE.md ---------- */

/** The CLAUDE.md the project uses: the root one, or `.claude/CLAUDE.md` when only that exists. */
export function claudeMdPath(root: string): string {
  return !existsSync(path.join(root, "CLAUDE.md")) && existsSync(path.join(root, ".claude", "CLAUDE.md"))
    ? ".claude/CLAUDE.md"
    : "CLAUDE.md";
}

function readClaudeMd(root: string): string {
  const file = path.join(root, ...claudeMdPath(root).split("/"));
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

const HEADING = "## Lessons";
const HOME_PATH = /(\/Users\/|\/home\/|[A-Z]:\\Users\\)\w/;

/**
 * CLAUDE.md with the lessons added as bullets under `## Lessons` (made at the end when missing). The rest of the file
 * stays exactly as it was.
 */
export function withLessons(before: string, lessons: { text: string }[], from: string): string {
  const bullets = lessons.map((l) => `- ${l.text.replace(/\s+/g, " ").trim()} (from ${from})`);
  const lines = before.split("\n");
  const at = lines.findIndex((l) => l.trim() === HEADING);
  if (at === -1) {
    const body = before.replace(/\n*$/, "");
    return `${body}${body ? "\n\n" : ""}${HEADING}\n\n${bullets.join("\n")}\n`;
  }
  // After the section's last line: the next heading of the same or a higher level ends it.
  let end = lines.findIndex((l, i) => i > at && /^#{1,2}\s/.test(l));
  if (end === -1) end = lines.length;
  while (end > at + 1 && lines[end - 1]?.trim() === "") end--;
  return [...lines.slice(0, end), ...bullets, ...lines.slice(end)].join("\n");
}

/** What the lessons would make of CLAUDE.md, for the diff the person reads before applying. */
export function previewLessons(root: string, taskId: string, ids: string[], from: string) {
  const chosen = storedLessons(root, taskId).filter((l) => ids.includes(l.id));
  if (!chosen.length) throw new Error(t("tasks.lessons.pickOne"));
  for (const l of chosen) {
    if (HOME_PATH.test(l.text)) throw new Error(t("tasks.lessons.homePath"));
    if (hasSecret(l.text)) throw new Error(t("tasks.lessons.secret"));
  }
  const before = readClaudeMd(root);
  const after = withLessons(before, chosen, from);
  if (after.split("\n").length > 300) throw new Error(t("tasks.lessons.tooLong"));
  return { path: claudeMdPath(root), before, after };
}

/** Adds the lessons to CLAUDE.md as a History run that can be rolled back; the ones not picked are dismissed. */
export function applyLessons(root: string, taskId: string, ids: string[], from: string, catalogVersion: string) {
  const { path: file, after } = previewLessons(root, taskId, ids, from);
  // Ignored before the run is recorded: dismissing the rest afterwards then doesn't change a file the run backed up,
  // which would stop it from rolling back cleanly.
  ensureIgnored(root, "lessons.json");
  const runId = applyFileEdits(
    root,
    { id: `lessons:${taskId}`, title: `Add ${ids.length} lesson${ids.length === 1 ? "" : "s"} to ${file}` },
    [{ path: file, content: after }],
    catalogVersion,
  );
  const rest = storedLessons(root, taskId)
    .filter((l) => !ids.includes(l.id))
    .map((l) => l.id);
  if (rest.length) dismissLessons(root, taskId, rest);
  writeJson(suggestionsFile(root, taskId), { lessons: [] });
  return { runId, path: file };
}

/* ---------- The model call ---------- */

const AnswerSchema = z.object({
  lessons: z
    .array(z.object({ text: z.string().min(5).max(400), why: z.string().max(400), sources: z.array(z.string()) }))
    .max(MAX_LESSONS),
});
const ANSWER_JSON_SCHEMA = {
  type: "object",
  properties: {
    lessons: {
      type: "array",
      maxItems: MAX_LESSONS,
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "One short imperative rule for this project's CLAUDE.md." },
          why: { type: "string", description: "One sentence: what in the run shows it's needed." },
          sources: { type: "array", items: { type: "string" }, description: "The refs of the signals it comes from." },
        },
        required: ["text", "why", "sources"],
      },
    },
  },
  required: ["lessons"],
} as const;

export function lessonPrompt(
  task: { title: string; objective: string },
  signals: Signal[],
  claudeMd: string,
  dismissed: string[],
): string {
  return [
    "A coding agent finished a task in this repository. Below is what its run recorded. Suggest at most",
    `${MAX_LESSONS} lessons for the project's CLAUDE.md: short imperative rules that would have avoided these problems`,
    "next time, for any task in this project. Only lessons the records support; none is fine.",
    "Don't repeat what CLAUDE.md already says or what was dismissed. Nothing about this one task's details. No secrets,",
    "no absolute or home-folder paths. Cite the refs of the signals each lesson comes from.",
    "",
    `Task: ${task.title}`,
    `Objective: ${task.objective}`,
    "",
    "Signals:",
    ...signals.map((s) => `- [${s.ref}] ${s.text.replace(/\n/g, "\n    ")}`),
    "",
    "CLAUDE.md now:",
    claudeMd.trim() ? claudeMd.slice(0, 12_000) : "(none)",
    "",
    "Dismissed before:",
    ...(dismissed.length ? dismissed.map((d) => `- ${d}`) : ["(none)"]),
  ].join("\n");
}

export type Claude = { sdk: AgentSdkModule; claudePath: string };

/**
 * Suggests lessons from a finished task's evidence: none, and no model call, when nothing in the run points at one.
 * Never throws for a failed call: the note says why there are none.
 */
export async function suggestLessons(
  claude: Claude,
  root: string,
  taskId: string,
  evidence: Evidence,
  model = "haiku",
): Promise<{ lessons: Lesson[]; costUsd: number; note?: string }> {
  const signals = lessonSignals(evidence);
  if (!signals.length) {
    writeJson(suggestionsFile(root, taskId), { lessons: [] });
    return {
      lessons: [],
      costUsd: 0,
      note: "Nothing in this run points at a lesson: no gate needed a fix, no review finding, no block or denial.",
    };
  }
  const claudeMd = readClaudeMd(root);
  const dismissed = dismissedLessons(root);
  const prompt = lessonPrompt(
    { title: evidence.task.request.slice(0, 200), objective: evidence.task.objective },
    signals,
    claudeMd,
    dismissed,
  );
  let costUsd = 0;
  let answer: z.infer<typeof AnswerSchema> | null = null;
  let note: string | undefined;
  try {
    const q = claude.sdk.query({
      prompt,
      options: {
        cwd: root,
        pathToClaudeCodeExecutable: claude.claudePath,
        model,
        tools: [],
        settingSources: [],
        persistSession: false,
        maxTurns: 3,
        maxBudgetUsd: 0.05,
        outputFormat: { type: "json_schema", schema: ANSWER_JSON_SCHEMA },
      },
    });
    for await (const m of q) {
      if (m.type !== "result") continue;
      costUsd += m.total_cost_usd;
      if (m.subtype !== "success") {
        note = `The suggestion stopped: ${m.subtype}.`;
        break;
      }
      const parsed = AnswerSchema.safeParse(m.structured_output);
      if (parsed.success) answer = parsed.data;
      else note = "The suggestion wasn't a valid answer.";
      break;
    }
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }
  const offered = answer?.lessons.length ?? 0;
  const known = [...linesOf(claudeMd), ...dismissed];
  const bySignal = new Map(signals.map((s) => [s.ref, s]));
  const lessons: Lesson[] = (answer?.lessons ?? [])
    .filter((l) => !isDuplicate(l.text, known) && !HOME_PATH.test(l.text) && !hasSecret(l.text))
    .map((l) => ({
      id: randomUUID().slice(0, 8),
      text: l.text.trim(),
      why: l.why.trim(),
      sources: l.sources.flatMap((r) => (bySignal.get(r) ? [bySignal.get(r) as Signal] : [])),
    }));
  writeJson(suggestionsFile(root, taskId), { lessons });
  return {
    lessons,
    costUsd,
    ...(note
      ? { note }
      : !lessons.length
        ? {
            note: offered
              ? "No new lesson: what the run shows is already in CLAUDE.md, or was dismissed."
              : "Nothing in this run makes a lesson for other tasks: what it shows is about this task only.",
          }
        : {}),
  };
}
