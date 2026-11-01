import { Bot, ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { type KeyboardEvent, useMemo, useState } from "react";
import type { Wait } from "../tabs.ts";
import type { Item } from "../transcript.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { MAIN_ID } from "./agentGraph.ts";
import { StatusIcon } from "./StatusIcon.tsx";
import { clock, type Span, type TimelineRow, ticks, timeline, turns } from "./timeline.ts";
import { useNow } from "./useNow.ts";

/**
 * The session's timeline (M4-04, design §6): a bar per agent on one time axis, so parallel work and approval waits
 * show at a glance. One turn at a time, the latest by default. Click a subagent's row, or move with the arrow keys and
 * press Enter, to open its drawer.
 */
export function SessionTimeline({
  items,
  waits,
  running,
  selected,
  onSelect,
}: {
  items: Item[];
  waits: readonly Wait[];
  running: boolean;
  selected: string | null;
  onSelect: (agentId: string | null) => void;
}) {
  const all = useMemo(() => turns(items), [items]);
  /** The turn shown; `null` follows the latest. */
  const [picked, setPicked] = useState<number | null>(null);
  const index = picked !== null && picked < all.length ? picked : all.length - 1;
  const latest = index === all.length - 1;
  const now = useNow(running && latest, 1000);
  const turn = all[index] ?? [];
  const t = useMemo(() => timeline(turn, waits, { now }), [turn, waits, now]);

  const nav =
    all.length > 1 ? (
      <div className="timeline-nav">
        <IconButton label="Earlier turn" disabled={index === 0} onClick={() => setPicked(index - 1)}>
          <ChevronLeft size={14} />
        </IconButton>
        <span>
          Turn {index + 1} of {all.length}
        </span>
        <IconButton
          label="Later turn"
          disabled={latest}
          onClick={() => setPicked(index + 1 === all.length - 1 ? null : index + 1)}
        >
          <ChevronRight size={14} />
        </IconButton>
        {firstLine(turn)}
      </div>
    ) : null;

  if (!t) {
    return (
      <div className="session-timeline">
        {nav}
        <p className="timeline-empty muted">
          {turn.some((i) => i.kind === "agent" || i.kind === "tool")
            ? "This session was reopened. Stored messages carry no times, so there is no timeline to draw; the graph shows the same agents in order."
            : "Nothing has run in this session yet."}
        </p>
      </div>
    );
  }

  const span = t.end - t.start;
  const pct = (ms: number) => `${(ms / span) * 100}%`;
  const place = (s: Span) => ({ left: pct(s.start - t.start), width: pct(Math.max(s.end - s.start, 0)) });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button.timeline-row")];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the rows' buttons (X-12).
    <div className="session-timeline" onKeyDown={onKeyDown}>
      {nav}
      <div className="timeline-axis" aria-hidden>
        <span className="timeline-label" />
        <span className="timeline-track">
          {ticks(span).map((ms) => (
            <span key={ms} className="timeline-tick" style={{ left: pct(ms) }}>
              {clock(ms)}
            </span>
          ))}
        </span>
      </div>
      <ul className="timeline-rows" aria-label="Agent timeline">
        {t.rows.map((r) => (
          <li key={r.id}>
            <Row row={r} selected={selected === r.id} place={place} onSelect={onSelect} />
          </li>
        ))}
      </ul>
      {t.rows.some((r) => r.waits.length) && (
        <p className="timeline-legend muted">
          <span className="timeline-wait-swatch" /> Waiting for your approval
        </p>
      )}
    </div>
  );
}

function Row({
  row: r,
  selected,
  place,
  onSelect,
}: {
  row: TimelineRow;
  selected: boolean;
  place: (s: Span) => { left: string; width: string };
  onSelect: (agentId: string | null) => void;
}) {
  const waited = r.waits.reduce((sum, w) => sum + (w.end - w.start), 0);
  const facts = [
    `ran ${clock(r.bar.end - r.bar.start)}${r.live ? " so far" : ""}`,
    waited ? `waited ${clock(waited)} for approval` : null,
    r.pausedMs ? `paused ${clock(r.pausedMs)}` : null,
  ].filter(Boolean);
  const content = (
    <>
      <span className="timeline-label" style={{ paddingInlineStart: `calc(${r.depth} * var(--space-3))` }}>
        {r.id === MAIN_ID ? <Sparkles size={13} aria-hidden /> : <Bot size={13} aria-hidden />}
        <span className="timeline-name">{r.label}</span>
        {r.status && <StatusIcon status={r.status} />}
      </span>
      <span className="timeline-track">
        <span className={`timeline-bar ${r.status ?? "main"}${r.live ? " live" : ""}`} style={place(r.bar)} />
        {r.waits.map((w) => (
          <span key={`${w.start}`} className="timeline-wait" style={place(w)} />
        ))}
      </span>
    </>
  );
  const title = `${r.label}: ${facts.join(", ")}`;
  if (r.id === MAIN_ID) {
    return (
      <div className="timeline-row main" title={title}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`timeline-row${selected ? " selected" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={selected}
      onClick={() => onSelect(selected ? null : r.id)}
    >
      {content}
    </button>
  );
}

/** The user's message that started a turn, as a hint next to its number. */
function firstLine(turn: Item[]) {
  const first = turn.find((i) => i.kind === "user");
  if (!first) return null;
  const line = first.text.split("\n")[0] ?? "";
  return (
    <span className="timeline-turn muted" title={first.text}>
      {line}
    </span>
  );
}
