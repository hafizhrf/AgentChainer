import type { SlashCommand } from "@agentchainer/protocol";
import { Check, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { APP_COMMANDS } from "./commands.ts";
import type { Tab } from "./tabs.ts";

/** What a slash command opens above the composer (UX-12), like the CLI's own `/model` and `/usage`. */
export type PopupKind = "model" | "mode" | "effort" | "usage" | "help";
export type PickerItem = { value: string; label: string; hint?: string; disabled?: boolean };

/**
 * A list to pick from, keyboard first: ↑/↓ move, Enter picks, Esc closes. It takes focus when it opens and gives it
 * back to the composer when it closes.
 */
export function PickerPopup({
  title,
  items,
  current,
  onPick,
  onClose,
}: {
  title: string;
  items: PickerItem[];
  current: string;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const [at, setAt] = useState(() =>
    Math.max(
      0,
      items.findIndex((i) => i.value === current),
    ),
  );
  const list = useRef<HTMLDivElement>(null);
  // The highlighted item has the focus (a roving focus), so the keys reach the list and a screen reader reads it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus whenever the highlight moves.
  useEffect(() => {
    list.current?.querySelector<HTMLButtonElement>(".active > .picker-item")?.focus();
  }, [at]);

  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (step) {
      e.preventDefault();
      setAt((a) => (a + step + items.length) % items.length);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // don't also stop the turn
      onClose();
    }
  }

  return (
    <Frame title={title} onClose={onClose}>
      <div className="picker" ref={list}>
        {items.map((item, i) => (
          <div
            key={item.value || "default"}
            className={`${i === at ? "active" : ""}${item.disabled ? " disabled" : ""}`}
          >
            <button
              type="button"
              className="picker-item"
              tabIndex={i === at ? 0 : -1}
              aria-disabled={item.disabled}
              aria-current={item.value === current}
              onMouseEnter={() => setAt(i)}
              onKeyDown={onKey}
              onClick={() => {
                if (!item.disabled) onPick(item.value);
              }}
            >
              <span className="picker-label">{item.label}</span>
              {item.hint && <span className="muted picker-hint">{item.hint}</span>}
              {item.value === current && <Check size={14} className="picker-current" aria-label="Current" />}
            </button>
          </div>
        ))}
      </div>
      <p className="muted popup-keys">↑/↓ move · Enter picks · Esc closes</p>
    </Frame>
  );
}

const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());
const usd = (n: number) => `≈$${n.toFixed(4)}`;

/** `/usage`: this chat's spend, tokens and what fills its context window. Estimates, as everywhere. */
export function UsagePopup({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const c = tab.context;
  const close = useEscape(onClose);
  return (
    <Frame title="Usage" onClose={onClose} onKeyDown={close}>
      <dl className="usage">
        <dt>Model</dt>
        <dd>{tab.model ?? "not known until the first turn"}</dd>
        <dt>This chat</dt>
        <dd>
          {tab.cost.totalUsd === null ? "not known for a resumed chat" : usd(tab.cost.totalUsd)}
          {tab.budgetUsd !== null && ` of a $${tab.budgetUsd.toFixed(2)} cap`}
        </dd>
        {tab.cost.lastUsd !== null && (
          <>
            <dt>Last turn</dt>
            <dd>
              {usd(tab.cost.lastUsd)}, {(tab.cost.lastMs / 1000).toFixed(1)} s
            </dd>
          </>
        )}
        {tab.cost.totalTokens && (
          <>
            <dt>Tokens</dt>
            <dd>
              {k(tab.cost.totalTokens.input)} in · {k(tab.cost.totalTokens.output)} out
            </dd>
          </>
        )}
      </dl>
      <h3 className="usage-heading">Context window</h3>
      {c ? (
        <>
          <div className={`usage-bar${c.percentage >= 80 ? " warn" : ""}`} aria-hidden>
            <span className="usage-fill" style={{ width: `${Math.min(100, c.percentage)}%` }} />
          </div>
          <p className="muted usage-line">
            {Math.round(c.percentage)}% used: {k(c.totalTokens)} of {k(c.maxTokens)} tokens
            {c.percentage >= 80 ? " · /compact summarizes earlier messages" : ""}
          </p>
          {c.categories && c.categories.length > 0 && (
            <table className="usage-table">
              <tbody>
                {c.categories.map((x) => (
                  <tr key={x.name}>
                    <th scope="row">{x.name}</th>
                    <td>{k(x.tokens)}</td>
                    <td className="muted">{((100 * x.tokens) / c.maxTokens).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <p className="muted">Shown after the first turn.</p>
      )}
      <p className="muted popup-keys">Costs are estimates · Esc closes</p>
    </Frame>
  );
}

/** `/help`: the app's commands, then the session's (the CLI's own, the project's, skills and plugins). */
export function HelpPopup({ commands, onClose }: { commands: SlashCommand[]; onClose: () => void }) {
  const close = useEscape(onClose);
  const app = new Set<string>(APP_COMMANDS.map((c) => c.name));
  const rows = (list: SlashCommand[]) =>
    list.map((c) => (
      <li key={c.name}>
        <code>/{c.name}</code>
        {c.argumentHint && <span className="muted"> {c.argumentHint}</span>}
        <span className="help-desc">{c.description}</span>
      </li>
    ));
  return (
    <Frame title="Commands" onClose={onClose} onKeyDown={close}>
      <h3 className="usage-heading">In the app</h3>
      <ul className="help-list">{rows(APP_COMMANDS)}</ul>
      <h3 className="usage-heading">Sent to Claude</h3>
      <ul className="help-list">{rows(commands.filter((c) => !app.has(c.name)))}</ul>
      <p className="muted popup-keys">Type / in the composer to search · Esc closes</p>
    </Frame>
  );
}

function useEscape(onClose: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };
}

function Frame({
  title,
  children,
  onClose,
  onKeyDown,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
}) {
  const box = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once, when the popup opens.
  useEffect(() => {
    if (onKeyDown) box.current?.focus();
  }, []);
  return (
    <section className="composer-popup" aria-label={title} ref={box} tabIndex={-1} onKeyDown={onKeyDown}>
      <header>
        <strong>{title}</strong>
        <span className="grow" />
        <button type="button" className="ghost icon tiny" aria-label={`Close ${title}`} onClick={onClose}>
          <X size={13} />
        </button>
      </header>
      {children}
    </section>
  );
}
