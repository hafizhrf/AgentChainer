import { EFFORTS, type Effort, type Image, PERMISSION_MODES, type PermissionMode } from "@agentchainer/protocol";
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { fuzzyFilter, tokenAt } from "./fuzzy.ts";
import { MODE_HELP, MODE_LABELS, MODELS } from "./SettingsPanel.tsx";
import { asMode, type Tab } from "./tabs.ts";

/** An image pasted into the composer: base64 data for the API and a data URL for the thumbnail. */
export type Attachment = Image & { preview: string };
type Queued = { text: string; images: Attachment[] };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The composer of a session tab (M1-13…M1-15):
 * - Enter sends; while a turn runs, messages queue and go out one by one after each successful turn.
 * - `@` suggests workspace files and `/` the session's slash commands and skills, both fuzzy-matched.
 * - Model, effort and permission profile switch mid-session.
 */
export function Composer({
  tab,
  files,
  actions,
  onSend,
  onInterrupt,
  onResume,
  onModeChange,
  onModelChange,
  onEffortChange,
}: {
  tab: Tab;
  /** Workspace-relative file paths for `@` mentions. */
  files: string[];
  /** Extra buttons on the left of the action row (panel toggles). */
  actions: ReactNode;
  onSend: (text: string, images: Attachment[]) => void;
  onInterrupt: () => void;
  onResume: () => void;
  onModeChange: (mode: PermissionMode) => void;
  onModelChange: (alias: string) => void;
  onEffortChange: (effort: Effort | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [images, setImages] = useState<Attachment[]>([]);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  /** Start of a token whose suggestions the user dismissed with Esc. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const wasRunning = useRef(tab.running);

  // Send the next queued message once a turn finishes successfully. Errors and the budget cap keep the queue.
  useEffect(() => {
    const finished = wasRunning.current && !tab.running;
    wasRunning.current = tab.running;
    if (!finished || tab.ended || tab.lastSubtype !== "success") return;
    const [next, ...rest] = queue;
    if (next === undefined) return;
    setQueue(rest);
    onSend(next.text, next.images);
  }, [tab.running, tab.ended, tab.lastSubtype, queue, onSend]);

  const token = tokenAt(draft, cursor);
  const suggestions = useMemo(() => {
    if (!token || token.start === dismissed) return [];
    return token.kind === "@" ? fuzzyFilter(token.query, files) : fuzzyFilter(token.query, tab.slashCommands);
  }, [token, dismissed, files, tab.slashCommands]);

  function submit() {
    const text = draft.trim();
    if (!text || tab.ended) return;
    setDraft("");
    setCursor(0);
    setImages([]);
    if (tab.running || queue.length > 0) setQueue((q) => [...q, { text, images }]);
    else onSend(text, images);
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
      if (images.length >= MAX_IMAGES) return setPasteError(`At most ${MAX_IMAGES} images per message.`);
      if (file.size > MAX_IMAGE_BYTES) return setPasteError("That image is over 5 MB; paste a smaller one.");
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

  function accept(choice: string) {
    if (!token) return;
    const prefix = token.kind === "@" ? "@" : "/";
    const insert = `${prefix}${choice} `;
    const next = draft.slice(0, token.start) + insert + draft.slice(cursor);
    const caret = token.start + insert.length;
    setDraft(next);
    setCursor(caret);
    setPick(0);
    requestAnimationFrame(() => area.current?.setSelectionRange(caret, caret));
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setPick((p) => (p + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(suggestions[Math.min(pick, suggestions.length - 1)] ?? "");
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation(); // don't also interrupt the turn
        setDismissed(token?.start ?? null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const track = (el: HTMLTextAreaElement) => setCursor(el.selectionStart);

  return (
    <footer className="composer">
      {queue.length > 0 && (
        <div className="queue">
          <span className="muted">Queued, sent after this turn:</span>
          {queue.map(({ text: q, images: qi }, i) => (
            // Queued messages can repeat, so the position is part of the key.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above.
            <span key={`${i}-${q}`} className="queued" title={q}>
              {q.length > 40 ? `${q.slice(0, 40)}…` : q}
              {qi.length > 0 && ` (+${qi.length} image${qi.length > 1 ? "s" : ""})`}
              <button
                type="button"
                className="link"
                aria-label="Remove from queue"
                onClick={() => setQueue((all) => all.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" className="link" onClick={() => setQueue([])} title="Stop after this turn">
            Clear queue
          </button>
        </div>
      )}
      {suggestions.length > 0 && (
        <ul className="suggestions" aria-label={token?.kind === "@" ? "Matching files" : "Matching commands"}>
          {suggestions.map((s, i) => (
            <li key={s} className={i === pick ? "active" : undefined}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => accept(s)}>
                {token?.kind === "/" ? `/${s}` : s}
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
              <img src={img.preview} alt={`Pasted screenshot ${i + 1}`} />
              <button
                type="button"
                className="link"
                aria-label={`Remove screenshot ${i + 1}`}
                onClick={() => setImages((all) => all.filter((_, j) => j !== i))}
              >
                ×
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
        placeholder={
          tab.running
            ? "Claude is working… type a follow-up to queue it (Esc stops the turn)"
            : "Ask Claude to do something… (Enter to send, Shift+Enter for a new line, @ for files, / for commands)"
        }
        onChange={(e) => {
          setDraft(e.target.value);
          track(e.target);
          setPick(0);
        }}
        onSelect={(e) => track(e.currentTarget)}
        onKeyDown={onKey}
        rows={3}
        disabled={tab.ended}
      />
      <div className="composer-actions">
        {actions}
        <select
          value={tab.mode}
          onChange={(e) => onModeChange(asMode(e.target.value))}
          aria-label="Permission profile"
          title={MODE_HELP[tab.mode]}
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m} value={m} disabled={m === "auto" && tab.budgetUsd === null}>
              {MODE_LABELS[m]}
              {m === "auto" && tab.budgetUsd === null ? " (needs a budget cap)" : ""}
            </option>
          ))}
        </select>
        <select value={tab.modelAlias} onChange={(e) => onModelChange(e.target.value)} aria-label="Model">
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.value ? m.label : "Default model"}
            </option>
          ))}
        </select>
        <select
          value={tab.effort ?? ""}
          onChange={(e) => onEffortChange((e.target.value || null) as Effort | null)}
          aria-label="Effort"
        >
          <option value="">Default effort</option>
          {EFFORTS.map((ef) => (
            <option key={ef} value={ef}>
              {ef} effort
            </option>
          ))}
        </select>
        <span className="grow" />
        {tab.ended ? (
          <button type="button" onClick={onResume} title="Continue this conversation in a new live session">
            Resume session
          </button>
        ) : (
          <>
            {tab.running && (
              <button type="button" className="secondary" onClick={onInterrupt} title="Stop the running turn (Esc)">
                Stop
              </button>
            )}
            <button type="button" disabled={!draft.trim()} onClick={submit}>
              {tab.running ? "Queue" : "Send"}
            </button>
          </>
        )}
      </div>
    </footer>
  );
}
