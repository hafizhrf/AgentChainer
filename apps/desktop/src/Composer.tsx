import { type Effort, type Image, PERMISSION_MODES, type PermissionMode } from "@agentchainer/protocol";
import { ArrowUp, ListPlus, Play, Square, X } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { fuzzyFilter, tokenAt } from "./fuzzy.ts";
import { EFFORT_OPTIONS, MODELS, modeOptions } from "./options.ts";
import { asMode, type Tab } from "./tabs.ts";
import { Select } from "./ui/Select.tsx";

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
  seed,
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
  /** Text to put in the composer (a starter prompt); a new object each time it's used. */
  seed: { text: string } | null;
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

  useEffect(() => {
    if (!seed) return;
    setDraft(seed.text);
    setCursor(seed.text.length);
    area.current?.focus();
  }, [seed]);

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
    <div className="composer">
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
                className="ghost icon tiny"
                aria-label="Remove from queue"
                onClick={() => setQueue((all) => all.filter((_, j) => j !== i))}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <button type="button" className="link" onClick={() => setQueue([])} title="Stop after this turn">
            Clear queue
          </button>
        </div>
      )}
      <div className="composer-box">
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
                  className="ghost icon tiny"
                  aria-label={`Remove screenshot ${i + 1}`}
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
          aria-label="Message to Claude"
          placeholder={
            tab.ended
              ? "This session ended. Resume it to continue."
              : tab.running
                ? "Claude is working… type a follow-up to queue it"
                : "Ask Claude to do something… @ for files, / for commands"
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
        <div className="composer-toolbar">
          <Select
            compact
            label="Permission profile"
            value={tab.mode}
            options={modeOptions(PERMISSION_MODES, tab.budgetUsd !== null)}
            onChange={(m) => onModeChange(asMode(m))}
            disabled={tab.ended}
          />
          <Select
            compact
            label="Model"
            value={tab.modelAlias}
            options={MODELS}
            onChange={onModelChange}
            disabled={tab.ended}
          />
          <Select
            compact
            label="Effort"
            value={tab.effort ?? ""}
            options={EFFORT_OPTIONS}
            onChange={(e) => onEffortChange((e || null) as Effort | null)}
            disabled={tab.ended}
          />
          <span className="grow" />
          {tab.ended ? (
            <button
              type="button"
              className="small"
              onClick={onResume}
              title="Continue this conversation in a new live session"
            >
              <Play size={14} />
              Resume session
            </button>
          ) : (
            <>
              <span className="composer-hint">{tab.running ? "Esc stops" : "Enter sends · Shift+Enter new line"}</span>
              {tab.running && (
                <button
                  type="button"
                  className="secondary icon round"
                  onClick={onInterrupt}
                  aria-label="Stop the running turn"
                  title="Stop (Esc)"
                >
                  <Square size={12} fill="currentColor" />
                </button>
              )}
              <button
                type="button"
                className="icon round"
                disabled={!draft.trim()}
                onClick={submit}
                aria-label={tab.running ? "Queue message" : "Send message"}
                title={tab.running ? "Queue (Enter)" : "Send (Enter)"}
              >
                {tab.running ? <ListPlus size={16} /> : <ArrowUp size={16} />}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
