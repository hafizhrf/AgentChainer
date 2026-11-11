import type { Effort, Image, PermissionMode } from "@agentchainer/protocol";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowUp, Bot, ListPlus, Paperclip, Pencil, Play, SendHorizontal, Square, Users, X } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { HelpPopup, PickerPopup, type PopupKind, UsagePopup } from "./ComposerPopup.tsx";
import {
  type AppCommand,
  mention,
  nextMode,
  POPUP_COMMANDS,
  parseAppCommand,
  sentMessages,
  slashMenu,
} from "./commands.ts";
import { appendToDraft } from "./diffComments.ts";
import { fuzzyFilter, tokenAt } from "./fuzzy.ts";
import { t } from "./i18n/index.ts";
import { ModeHelp } from "./ModeHelp.tsx";
import { agentModes, EFFORT_OPTIONS, MODE_HELP, MODE_NAMES, modelChoices, modeOptions } from "./options.ts";
import { asMode, isFresh, type Tab } from "./tabs.ts";
import { agentLabel } from "./tasks/stepAgent.ts";
import { teamSpend, usdShort } from "./team.ts";
import { Select } from "./ui/Select.tsx";

/** An image pasted into the composer: base64 data for the API and a data URL for the thumbnail. */
export type Attachment = Image & { preview: string };
type Queued = { text: string; images: Attachment[] };
/** One row of the `@` or `/` menu. */
type Suggestion = { key: string; insert: string; label: string; hint?: string; detail?: string };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The composer of a session tab (M1-13…M1-15, UX-12):
 * - Enter sends; while a turn runs, messages queue and go out one by one after each successful turn. A queued message
 *   can be edited, or sent now (which stops the turn first).
 * - `@` suggests workspace files and `/` the app's and the session's commands, with their descriptions. App commands
 *   (`/clear`, `/model`, …) run here; every other command goes to Claude as typed.
 * - Shift+Tab cycles the permission mode; ↑/↓ walk the messages sent in this session.
 * - Files can be attached (a picker, or dropped on the window): they go in as `@path`, which Claude reads.
 */
export function Composer({
  tab,
  active,
  files,
  seed,
  onSend,
  onTask,
  onTeam,
  onCommand,
  onInterrupt,
  onResume,
  onModeChange,
  onModelChange,
  onEffortChange,
}: {
  tab: Tab;
  /** The tab is the one shown: only then do dropped files land here. */
  active: boolean;
  /** Workspace-relative file paths for `@` mentions. */
  files: string[];
  /**
   * Text to put in the composer, a new object each time it's used: a starter prompt replaces the draft; diff comments
   * (CP-05) are appended to it.
   */
  seed: { text: string; append?: boolean } | null;
  onSend: (text: string, images: Attachment[]) => void;
  /** Makes a task of the text (UX-13); without it (the Tasks preview off), the composer is chat only. */
  onTask?: (text: string) => void;
  /** Starts the chat over as a Team chat, or as a plain one again (M8-03). */
  onTeam: (on: boolean) => void;
  onCommand: (name: AppCommand, arg: string) => void;
  onInterrupt: () => void;
  onResume: () => void;
  onModeChange: (mode: PermissionMode) => void;
  onModelChange: (alias: string) => void;
  onEffortChange: (effort: Effort | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const agentName = agentLabel(tab.agent ?? "claude", undefined);
  const [cursor, setCursor] = useState(0);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [images, setImages] = useState<Attachment[]>([]);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  const [dropping, setDropping] = useState(false);
  /** Chat sends to Claude; Task makes a task of the text, which Claude drafts a contract for first (UX-13). */
  const [kind, setKind] = useState<"chat" | "task">(onTask ? (tab.kind ?? "chat") : "chat");
  useEffect(() => {
    if (tab.kind && onTask) setKind(tab.kind);
  }, [tab.kind, onTask]);
  /** A picker or panel a slash command opened (UX-12). */
  const [popup, setPopup] = useState<PopupKind | null>(null);
  const closePopup = () => {
    setPopup(null);
    requestAnimationFrame(() => area.current?.focus());
  };
  /** Start of a token whose suggestions the user dismissed with Esc. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  /** Where ↑/↓ is in the sent messages (null: not browsing), and the draft to come back to. */
  const history = useRef<{ index: number; draft: string } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const wasRunning = useRef(tab.running);
  /** "Send now" stopped the turn: the next queued message goes out however that turn ended. */
  const flush = useRef(false);
  const sent = useMemo(() => sentMessages(tab.items), [tab.items]);
  const canAutonomous = tab.budgetUsd !== null;

  // The draft as last rendered, for a seed that adds to it.
  const draftNow = useRef(draft);
  draftNow.current = draft;
  useEffect(() => {
    if (!seed) return;
    const next = seed.append ? appendToDraft(draftNow.current, seed.text) : seed.text;
    setDraft(next);
    setCursor(next.length);
    area.current?.focus();
  }, [seed]);

  // Send the next queued message once a turn finishes successfully. Errors and the budget cap keep the queue, unless
  // the turn was stopped to send a message now.
  useEffect(() => {
    const finished = wasRunning.current && !tab.running;
    wasRunning.current = tab.running;
    if (!finished || tab.ended) return;
    if (tab.lastSubtype !== "success" && !flush.current) return;
    flush.current = false;
    const [next, ...rest] = queue;
    if (next === undefined) return;
    setQueue(rest);
    onSend(next.text, next.images);
  }, [tab.running, tab.ended, tab.lastSubtype, queue, onSend]);

  const insert = (text: string) => {
    const el = area.current;
    const at = el ? el.selectionStart : draft.length;
    const pad = at > 0 && !/\s$/.test(draft.slice(0, at)) ? " " : "";
    const next = `${draft.slice(0, at)}${pad}${text} ${draft.slice(at)}`;
    const caret = at + pad.length + text.length + 1;
    setDraft(next);
    setCursor(caret);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(caret, caret);
    });
  };
  const insertRef = useRef(insert);
  insertRef.current = insert;

  // Files dropped on the window go to the shown tab's composer as `@path` (Tauri hands the drop to the app).
  useEffect(() => {
    if (!active || tab.ended) return;
    let stop: (() => void) | undefined;
    let gone = false;
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "over" || e.payload.type === "enter") setDropping(true);
        else if (e.payload.type === "leave") setDropping(false);
        else if (e.payload.type === "drop") {
          setDropping(false);
          for (const p of e.payload.paths) insertRef.current(mention(tab.cwd, p));
        }
      })
      .then((un) => {
        if (gone) un();
        else stop = un;
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      stop?.();
    };
  }, [active, tab.ended, tab.cwd]);

  const token = tokenAt(draft, cursor);
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!token || token.start === dismissed) return [];
    if (token.kind === "@") return fuzzyFilter(token.query, files).map((f) => ({ key: f, insert: `@${f}`, label: f }));
    return slashMenu(tab.slashCommands, token.query).map((c) => ({
      key: c.name,
      insert: `/${c.name}`,
      label: `/${c.name}`,
      ...(c.argumentHint ? { hint: c.argumentHint } : {}),
      ...(c.description
        ? { detail: c.app ? t("session.composer.appCommand", { description: c.description }) : c.description }
        : {}),
    }));
  }, [token, dismissed, files, tab.slashCommands]);

  function submit(typed = draft) {
    const text = typed.trim();
    if (!text || tab.ended) return;
    setDraft("");
    setCursor(0);
    setDismissed(null);
    history.current = null;
    const command = parseAppCommand(text);
    // `/model`, `/usage`… without an argument open their picker or panel, like the CLI's.
    if (command && !command.arg && POPUP_COMMANDS.has(command.name)) return setPopup(command.name as PopupKind);
    if (command?.name === "task" && !command.arg && onTask) return setKind("task");
    if (command) return onCommand(command.name, command.arg);
    if (kind === "task" && onTask && !command) {
      setKind("chat");
      return onTask(text);
    }
    setImages([]);
    if (tab.running || queue.length > 0) setQueue((q) => [...q, { text, images }]);
    else onSend(text, images);
  }

  /** Puts a queued message back in the composer to change it. */
  function edit(i: number) {
    const q = queue[i];
    if (!q) return;
    setQueue((all) => all.filter((_, j) => j !== i));
    setDraft(q.text);
    setImages(q.images);
    setCursor(q.text.length);
    area.current?.focus();
  }

  /** Sends a queued message now: it goes first, and the running turn stops. */
  function sendNow(i: number) {
    const q = queue[i];
    if (!q) return;
    setQueue((all) => [q, ...all.filter((_, j) => j !== i)]);
    flush.current = true;
    onInterrupt();
  }

  async function attach() {
    const picked = await open({ multiple: true, title: t("session.composer.attachDialogTitle") }).catch(() => null);
    for (const p of Array.isArray(picked) ? picked : picked ? [picked] : []) insert(mention(tab.cwd, p));
  }

  /** Pasted screenshots become image attachments (M1-13); other pastes stay text. */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.items]
      .filter((item) => item.kind === "file" && IMAGE_TYPES.has(item.type))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    setPasteError(null);
    for (const file of files) {
      if (images.length >= MAX_IMAGES) return setPasteError(t("session.composer.tooManyImages", { count: MAX_IMAGES }));
      if (file.size > MAX_IMAGE_BYTES) return setPasteError(t("session.composer.imageTooLarge"));
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        setImages((all) => [
          ...all,
          { mediaType: file.type as Attachment["mediaType"], data: url.slice(url.indexOf(",") + 1), preview: url },
        ]);
      };
      reader.readAsDataURL(file);
    }
  }

  function accept(choice: Suggestion | undefined) {
    if (!token || !choice) return;
    const insertText = `${choice.insert} `;
    const next = draft.slice(0, token.start) + insertText + draft.slice(cursor);
    const caret = token.start + insertText.length;
    setDraft(next);
    setCursor(caret);
    setPick(0);
    requestAnimationFrame(() => area.current?.setSelectionRange(caret, caret));
  }

  /** ↑/↓ through the sent messages, from the first line (↑) or the last (↓) only, so multi-line edits still work. */
  function browse(e: KeyboardEvent<HTMLTextAreaElement>, step: -1 | 1): boolean {
    const el = e.currentTarget;
    const before = el.value.slice(0, el.selectionStart);
    const after = el.value.slice(el.selectionEnd);
    if ((step === -1 && before.includes("\n")) || (step === 1 && after.includes("\n"))) return false;
    if (history.current === null && step === 1) return false;
    if (sent.length === 0) return false;
    const h = history.current ?? { index: sent.length, draft };
    const index = Math.max(0, Math.min(sent.length, h.index + step));
    history.current = index === sent.length ? null : { ...h, index };
    const text = index === sent.length ? h.draft : (sent[index] ?? "");
    setDraft(text);
    setCursor(text.length);
    requestAnimationFrame(() => area.current?.setSelectionRange(text.length, text.length));
    return true;
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Shift+Tab cycles the mode, as in the CLI; plain Tab still accepts a suggestion.
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      if (!tab.ended) onModeChange(nextMode(tab.mode, canAutonomous));
      return;
    }
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setPick((p) => (p + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const choice = suggestions[Math.min(pick, suggestions.length - 1)];
        // Enter runs the highlighted command, as in the CLI; Tab completes it, to type an argument after it.
        if (e.key === "Enter" && token?.kind === "/" && choice) {
          submit(choice.insert);
          return;
        }
        accept(choice);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // don't also interrupt the turn
        setDismissed(token?.start ?? null);
        return;
      }
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey) {
      if (browse(e, e.key === "ArrowUp" ? -1 : 1)) e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const track = (el: HTMLTextAreaElement) => setCursor(el.selectionStart);

  return (
    <div className="composer">
      {queue.length > 0 && (
        <div className="queue">
          <span className="muted">{t("session.composer.queued")}</span>
          {queue.map(({ text: q, images: qi }, i) => (
            // Queued messages can repeat, so the position is part of the key.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above.
            <span key={`${i}-${q}`} className="queued" title={q}>
              {q.length > 40 ? `${q.slice(0, 40)}…` : q}
              {qi.length > 0 && ` ${t("session.composer.queuedImages", { count: qi.length })}`}
              <button
                type="button"
                className="ghost icon tiny"
                aria-label={t("session.composer.editQueued")}
                onClick={() => edit(i)}
              >
                <Pencil size={12} />
              </button>
              {tab.running && (
                <button
                  type="button"
                  className="ghost icon tiny"
                  aria-label={t("session.composer.sendNowLabel")}
                  title={t("session.composer.sendNowTitle")}
                  onClick={() => sendNow(i)}
                >
                  <SendHorizontal size={12} />
                </button>
              )}
              <button
                type="button"
                className="ghost icon tiny"
                aria-label={t("session.composer.removeQueued")}
                onClick={() => setQueue((all) => all.filter((_, j) => j !== i))}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="link"
            onClick={() => setQueue([])}
            title={t("session.composer.clearQueueTitle")}
          >
            {t("session.composer.clearQueue")}
          </button>
        </div>
      )}
      {popup === "model" && (
        <PickerPopup
          title={t("session.composer.modelPicker")}
          items={modelChoices(tab.models.length ? tab.models : undefined, tab.modelAlias, agentName)}
          current={tab.modelAlias}
          onPick={(v) => {
            onModelChange(v);
            closePopup();
          }}
          onClose={closePopup}
        />
      )}
      {popup === "mode" && (
        <PickerPopup
          title={t("session.composer.modePicker")}
          items={(["default", "acceptEdits", "plan", "auto"] as const).map((m) => ({
            value: m,
            label: MODE_NAMES[m],
            hint: m === "auto" && !canAutonomous ? t("session.composer.needsBudgetCap") : MODE_HELP[m],
            disabled: m === "auto" && !canAutonomous,
          }))}
          current={tab.mode}
          onPick={(v) => {
            onModeChange(asMode(v));
            closePopup();
          }}
          onClose={closePopup}
        />
      )}
      {popup === "effort" && (
        <PickerPopup
          title={t("session.composer.effortPicker")}
          items={EFFORT_OPTIONS}
          current={tab.effort ?? ""}
          onPick={(v) => {
            onEffortChange((v || null) as Effort | null);
            closePopup();
          }}
          onClose={closePopup}
        />
      )}
      {popup === "usage" && <UsagePopup tab={tab} onClose={closePopup} />}
      {popup === "help" && <HelpPopup commands={tab.slashCommands} onClose={closePopup} />}
      <div
        className={`composer-box${dropping ? " dropping" : ""}${kind === "task" ? " task-kind" : ""}`}
        data-mode={kind === "task" ? "plan" : tab.mode}
      >
        {suggestions.length > 0 && (
          <ul
            className="suggestions"
            aria-label={
              token?.kind === "@" ? t("session.composer.matchingFiles") : t("session.composer.matchingCommands")
            }
          >
            {suggestions.map((s, i) => (
              <li key={s.key} className={i === pick ? "active" : undefined}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => accept(s)}>
                  <span className="suggestion-name">{s.label}</span>
                  {s.hint && <span className="suggestion-hint">{s.hint}</span>}
                  {s.detail && <span className="suggestion-detail">{s.detail}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {images.length > 0 && (
          <div className="attachments">
            {images.map((img, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: attachments have no ids; removal is by position.
              <span key={i} className="attachment">
                <img src={img.preview} alt={t("session.composer.pastedScreenshot", { n: i + 1 })} />
                <button
                  type="button"
                  className="ghost icon tiny"
                  aria-label={t("session.composer.removeScreenshot", { n: i + 1 })}
                  onClick={() => setImages((all) => all.filter((_, j) => j !== i))}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {pasteError && <p className="warn">{pasteError}</p>}
        <textarea
          ref={area}
          onPaste={onPaste}
          value={draft}
          aria-label={t("session.composer.messageLabel")}
          placeholder={
            tab.ended
              ? t("session.composer.placeholderEnded")
              : dropping
                ? t("session.composer.placeholderDrop")
                : kind === "task"
                  ? t("session.composer.placeholderTask")
                  : tab.running
                    ? t("session.composer.placeholderRunning", { agent: agentName })
                    : t("session.composer.placeholder", { agent: agentName })
          }
          onChange={(e) => {
            setDraft(e.target.value);
            track(e.target);
            setPick(0);
            // A dismissed menu stays shut for that token only: once it's gone, the next one opens again.
            if (dismissed !== null && !tokenAt(e.target.value, e.target.selectionStart)) setDismissed(null);
            history.current = null;
          }}
          onSelect={(e) => track(e.currentTarget)}
          onKeyDown={onKey}
          rows={3}
          disabled={tab.ended}
        />
        <div className="composer-toolbar">
          {/* What the message is sent with; these wrap onto a second row rather than squeeze into each other. */}
          <div className="composer-controls">
            {onTask && (
              <fieldset className="segmented kind-switch">
                <legend className="sr-only">{t("session.composer.sendAs")}</legend>
                {(["chat", "task"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={kind === k ? "active" : undefined}
                    aria-pressed={kind === k}
                    title={k === "chat" ? t("session.composer.chatTitle") : t("session.composer.taskTitle")}
                    onClick={() => setKind(k)}
                  >
                    {k === "chat" ? t("session.composer.chat") : t("session.composer.task")}
                  </button>
                ))}
              </fieldset>
            )}
            {/* Which agent the chat runs on (UX-20, M9-09). */}
            <span className="chip composer-agent" title={t("session.composer.agentTitle", { agent: agentName })}>
              <Bot size={12} aria-hidden />
              {agentName}
            </span>
            <Select
              compact
              label={t("session.composer.modeLabel")}
              value={tab.mode}
              // Each agent's own modes (M9-09).
              options={modeOptions(agentModes(tab.agent), canAutonomous)}
              onChange={(m) => onModeChange(asMode(m))}
              disabled={tab.ended}
            />
            <ModeHelp current={tab.mode} />
            <Select
              compact
              label={t("session.composer.modelLabel")}
              value={tab.modelAlias}
              options={modelChoices(tab.models.length ? tab.models : undefined, tab.modelAlias, agentName)}
              onChange={onModelChange}
              disabled={tab.ended}
            />
            {/* agy's models carry their effort in their names (M9-09). */}
            {tab.agent !== "agy" && (
              <Select
                compact
                label={t("session.composer.effortLabel")}
                value={tab.effort ?? ""}
                options={EFFORT_OPTIONS}
                onChange={(e) => onEffortChange((e || null) as Effort | null)}
                disabled={tab.ended}
              />
            )}
            <button
              type="button"
              className="ghost icon"
              aria-label={t("session.composer.attachLabel")}
              title={t("session.composer.attachTitle")}
              onClick={() => void attach()}
              disabled={tab.ended}
            >
              <Paperclip size={14} />
            </button>
            {/* A Team chat (M8-03) is chosen before the first message; a worker's tab can't be one, nor a Codex chat. */}
            {!tab.parentId && !tab.agent && isFresh(tab) && (
              <button
                type="button"
                className="ghost small team-toggle"
                aria-pressed={tab.team !== undefined}
                title={
                  tab.team
                    ? t("session.composer.teamOn", { spend: teamSpend(tab.team) })
                    : t("session.composer.teamOff")
                }
                onClick={() => onTeam(tab.team === undefined)}
              >
                <Users size={14} />
                {t("session.composer.team")}
              </button>
            )}
          </div>
          <div className="composer-actions">
            {tab.team && (
              <span className={`team-spend${tab.team.stopped ? " stopped" : ""}`} title={teamSpend(tab.team)}>
                <Users size={12} aria-hidden />
                {tab.team.stopped
                  ? t("session.composer.teamStopped")
                  : `${usdShort(tab.team.spentUsd)} / ${usdShort(tab.team.capUsd)}`}
              </span>
            )}
            {tab.context && !tab.ended && (
              <ContextRing
                percentage={tab.context.percentage}
                disabled={tab.running}
                onCompact={() => onSend("/compact", [])}
              />
            )}
            {tab.ended ? (
              <button type="button" className="small" onClick={onResume} title={t("session.composer.resumeTitle")}>
                <Play size={14} />
                {t("session.composer.resume")}
              </button>
            ) : (
              <>
                <span className="composer-hint">
                  {tab.running ? t("session.composer.hintRunning") : t("session.composer.hint")}
                </span>
                {tab.running && (
                  <button
                    type="button"
                    className="secondary icon round"
                    onClick={onInterrupt}
                    aria-label={t("session.composer.stopLabel")}
                    title={t("session.composer.stopTitle")}
                  >
                    <Square size={12} fill="currentColor" />
                  </button>
                )}
                <button
                  type="button"
                  className="icon round"
                  disabled={!draft.trim()}
                  onClick={() => submit()}
                  aria-label={tab.running ? t("session.composer.queueLabel") : t("session.composer.sendLabel")}
                  title={tab.running ? t("session.composer.queueTitle") : t("session.composer.sendTitle")}
                >
                  {tab.running ? <ListPlus size={16} /> : <ArrowUp size={16} />}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * How full the context window is, as a ring that fills up (owner request, 2026-11-03, like Claude's own apps); a click
 * summarizes earlier messages with the CLI's `/compact`. The tooltip says what's left in words, so it's never the
 * ring alone.
 */
function ContextRing({
  percentage,
  disabled,
  onCompact,
}: {
  percentage: number;
  disabled: boolean;
  onCompact: () => void;
}) {
  const used = Math.min(100, Math.max(0, percentage));
  const left = Math.round(100 - used);
  const r = 7;
  const around = 2 * Math.PI * r;
  const label = disabled
    ? t("session.composer.contextLeftBusy", { left })
    : t("session.composer.contextLeft", { left });
  return (
    <button
      type="button"
      className={`ghost icon context-ring${used >= 80 ? " warn" : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onCompact}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={r} className="context-ring-track" />
        <circle
          cx="9"
          cy="9"
          r={r}
          className="context-ring-fill"
          strokeDasharray={`${(used / 100) * around} ${around}`}
          transform="rotate(-90 9 9)"
        />
      </svg>
    </button>
  );
}
