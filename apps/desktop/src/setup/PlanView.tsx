import type { PlanAction, PlanPreview } from "@agentchainer/protocol";
import { Check, CircleCheck, CircleX, Loader2, MinusCircle, Play, Sparkles, X } from "lucide-react";
import { t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
import { lineDiff } from "../textdiff.ts";
import { EmptyState, Section } from "../ui/Section.tsx";
import type { Bootstrap, Outcome } from "./useBootstrap.tsx";

const KIND: Record<PlanAction["kind"], string> = {
  get fix() {
    return t("setup.plan.kindFix");
  },
  get catalog() {
    return t("setup.plan.kindCatalog");
  },
  get generator() {
    return t("setup.plan.kindGenerator");
  },
};

/** Not applicable now and not fixable from here: shown last, collapsed. */
const parked = (a: PlanAction) => a.state === "unavailable" && !a.generatable;

/**
 * The bootstrap plan as master and detail (M2-12): actions grouped on the left, with a checkbox, a one-line summary
 * and the risk; the focused action's why, trust, permissions and exact preview on the right; Apply at the bottom.
 */
export function PlanView({
  bootstrap: b,
  focus,
  onFocus,
}: {
  bootstrap: Bootstrap;
  focus: string | null;
  onFocus: (id: string) => void;
}) {
  const { plan } = b;
  if (b.error && !plan) return <p className="warn setup-pad">{b.error}</p>;
  if (!plan) return <p className="muted setup-pad">{t("setup.plan.building")}</p>;

  const open = (a: PlanAction) => a.state === "recommended" || a.state === "optional";
  const groups: { id: string; title: string; actions: PlanAction[]; collapsed?: boolean }[] = [
    { id: "fix", title: t("setup.plan.groupFixes"), actions: plan.actions.filter((a) => a.kind === "fix" && open(a)) },
    {
      id: "catalog",
      title: t("setup.plan.groupCatalog", { version: plan.catalogVersion }),
      actions: plan.actions.filter((a) => a.kind === "catalog" && open(a)),
    },
    {
      id: "generator",
      title: t("setup.plan.groupGenerated"),
      actions: plan.actions.filter((a) => a.kind === "generator" && a.state !== "installed" && !parked(a)),
    },
    {
      id: "installed",
      title: t("setup.plan.groupInstalled"),
      actions: plan.actions.filter((a) => a.state === "installed"),
    },
    { id: "parked", title: t("setup.plan.groupParked"), actions: plan.actions.filter(parked), collapsed: true },
  ];
  const focused = plan.actions.find((a) => a.id === focus) ?? groups.flatMap((g) => g.actions)[0] ?? null;
  const optional = plan.profiles.filter((p) => !p.suggested);

  return (
    <div className="plan-view">
      <div className="plan-toolbar">
        <span className="muted">{t("setup.plan.profiles")}</span>
        {plan.profiles
          .filter((p) => p.suggested)
          .map((p) => (
            <span key={p.id} className="chip on" title={t("setup.plan.suggested", { description: p.description })}>
              <Check size={12} />
              {p.name}
            </span>
          ))}
        {optional.map((p) => {
          const on = b.optIn.includes(p.id);
          return (
            <button
              key={p.id}
              type="button"
              className={`chip${on ? " on" : ""}`}
              aria-pressed={on}
              title={p.description}
              onClick={() => b.setOptIn((o) => (on ? o.filter((x) => x !== p.id) : [...o, p.id]))}
            >
              {on && <Check size={12} />}
              {p.name}
            </button>
          );
        })}
      </div>

      {b.error && <p className="warn setup-pad">{b.error}</p>}
      {b.outcome && <OutcomeList outcome={b.outcome} onDismiss={b.clearOutcome} />}

      <div className="plan-split">
        <div className="plan-list">
          {groups.map(
            (g) =>
              g.actions.length > 0 && (
                <Section
                  key={g.id}
                  id={`plan.${g.id}`}
                  title={g.title}
                  count={g.actions.length}
                  defaultOpen={!g.collapsed}
                >
                  <ul>
                    {g.actions.map((a) => (
                      <PlanRow
                        key={a.id}
                        action={a}
                        focused={focused?.id === a.id}
                        checked={b.selected.has(a.id)}
                        onToggle={() => b.toggle(a.id)}
                        onFocus={() => onFocus(a.id)}
                      />
                    ))}
                  </ul>
                </Section>
              ),
          )}
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable, so the keyboard can scroll it when it's taller than the window. */}
        <section className="plan-detail" aria-label={t("setup.plan.details")} tabIndex={0}>
          {focused ? (
            <ActionDetails
              action={focused}
              generating={b.generating}
              disabled={b.busy || b.generating !== null}
              onGenerate={() => void b.generate(focused)}
              install={b.install.has(focused.id)}
              onToggleInstall={() => b.toggleInstall(focused.id)}
            />
          ) : (
            <EmptyState>{t("setup.plan.nothing")}</EmptyState>
          )}
        </section>
      </div>

      <footer className="plan-footer">
        <span className="muted grow">
          {b.generating
            ? t("setup.plan.generating")
            : (b.generated ??
              t("setup.plan.selectedCount", { n: b.selected.size, total: plan.actions.filter(open).length }))}
        </span>
        <button type="button" disabled={b.selected.size === 0 || b.busy} onClick={() => void b.apply()}>
          {b.busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
          {b.busy ? t("setup.plan.working") : t("setup.plan.applySelected", { n: b.selected.size })}
        </button>
      </footer>
    </div>
  );
}

function PlanRow({
  action: a,
  focused,
  checked,
  onToggle,
  onFocus,
}: {
  action: PlanAction;
  focused: boolean;
  checked: boolean;
  onToggle: () => void;
  onFocus: () => void;
}) {
  const selectable = a.state === "recommended" || a.state === "optional";
  const meta = [a.tier, KIND[a.kind], t("setup.plan.scope", { scope: a.scope }), stateNote(a)]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className={`plan-row${focused ? " focused" : ""}${selectable ? "" : " inactive"}`}>
      <input
        type="checkbox"
        aria-label={t("setup.plan.include", { title: a.title })}
        checked={checked}
        disabled={!selectable}
        onChange={onToggle}
      />
      <button type="button" className="plan-row-main" aria-current={focused} onClick={onFocus}>
        <span className="plan-title">{a.title}</span>
        <span className="plan-meta">{meta}</span>
      </button>
      <RiskPill risk={a.risk} />
    </li>
  );
}

function stateNote(a: PlanAction): string | null {
  if (a.state === "optional") return t("setup.plan.stateOptional");
  if (a.state === "installed") return t("setup.plan.stateInstalled");
  if (a.state === "unavailable")
    return a.generatable ? t("setup.plan.stateNeedsProposal") : t("setup.plan.stateUnavailable");
  return null;
}

export function RiskPill({ risk }: { risk: PlanAction["risk"] }) {
  return (
    <span className={`risk risk-${risk}`} title={t("setup.plan.risk", { risk })}>
      <span className="risk-dot" />
      {risk}
    </span>
  );
}

function ActionDetails({
  action: a,
  generating,
  disabled,
  onGenerate,
  install,
  onToggleInstall,
}: {
  action: PlanAction;
  generating: string | null;
  disabled: boolean;
  onGenerate: () => void;
  install: boolean;
  onToggleInstall: () => void;
}) {
  return (
    <article className="action-details">
      <header className="action-head">
        <h3>{a.title}</h3>
        <div className="action-tags">
          <RiskPill risk={a.risk} />
          {a.tier && <span className={`badge tier-${a.tier}`}>{a.tier}</span>}
          <span className="badge">{KIND[a.kind]}</span>
        </div>
        {a.generatable && (
          <button
            type="button"
            className="secondary small"
            disabled={disabled}
            title={t("setup.plan.generateTitle")}
            onClick={onGenerate}
          >
            {generating === a.id ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
            {generating === a.id
              ? t("setup.plan.generatingShort")
              : a.preview.type === "files"
                ? t("setup.plan.regenerate")
                : t("setup.plan.generateProposal")}
          </button>
        )}
      </header>
      {a.reason && <p className="callout">{a.reason}</p>}
      <p>{a.why}</p>
      <dl className="action-facts">
        {a.source && (
          <>
            <dt>{t("setup.plan.factSource")}</dt>
            <dd>
              <code>{a.source}</code>
            </dd>
          </>
        )}
        {a.license && (
          <>
            <dt>{t("setup.plan.factLicense")}</dt>
            <dd>{a.license}</dd>
          </>
        )}
        <dt>{t("setup.plan.factScope")}</dt>
        <dd>{a.scope}</dd>
        {a.permissions.length > 0 && (
          <>
            <dt>{t("setup.plan.factPermissions")}</dt>
            <dd>
              <ul>
                {a.permissions.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {a.secrets.length > 0 && (
          <>
            <dt>{t("setup.plan.factSecrets")}</dt>
            <dd>
              {a.secrets.map((s) => (
                <code key={s}>{s}</code>
              ))}{" "}
              {t("setup.plan.secretsNote")}
            </dd>
          </>
        )}
      </dl>
      {a.notes && <p className={a.kind === "generator" ? "muted" : "warn"}>{a.notes}</p>}
      {a.checks && <Checks checks={a.checks} />}
      {a.installCommand && (
        <label className="check install-consent">
          <input type="checkbox" checked={install} onChange={onToggleInstall} />
          <span>
            <Rich
              k="setup.plan.installFirst"
              params={{ command: a.installCommand }}
              tags={{ code: (s) => <code>{s}</code> }}
            />
            <span className="field-help">{t("setup.plan.installFirstHelp")}</span>
          </span>
        </label>
      )}
      <h4 className="preview-title">{t("setup.plan.whatChanges")}</h4>
      <Preview preview={a.preview} />
    </article>
  );
}

export function Checks({ checks }: { checks: NonNullable<PlanAction["checks"]> }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.name} className={`check-${c.status}`}>
          {c.status === "pass" ? (
            <CircleCheck size={14} className="check-icon" />
          ) : c.status === "fail" ? (
            <CircleX size={14} className="check-icon" />
          ) : (
            <MinusCircle size={14} className="check-icon" />
          )}
          <span>
            {c.name} <span className="muted">{c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function FileDiff({ path, before, after }: { path: string; before: string; after: string }) {
  return (
    <div className="preview-file">
      <code className="preview-path">
        {path}
        {before ? "" : ` ${t("setup.plan.newFile")}`}
      </code>
      <pre className="plan-preview inline-diff">
        {lineDiff(before, after).map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed diff.
          <span key={i} className={l.op === "+" ? "add" : l.op === "-" ? "del" : ""}>
            {l.op} {l.text}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

function Preview({ preview }: { preview: PlanPreview }) {
  if (preview.type === "note") return <p className="muted">{preview.text}</p>;
  if (preview.type === "files") {
    return (
      <>
        {preview.files.map((f) => (
          <FileDiff key={f.path} {...f} />
        ))}
      </>
    );
  }
  if (preview.type === "commands") {
    return (
      <pre className="plan-preview">
        {preview.commands
          .map((argv) => argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" "))
          .join("\n")}
      </pre>
    );
  }
  return <FileDiff path={preview.path} before={preview.before} after={preview.after} />;
}

/** What the last apply or rollback did, per action. */
export function OutcomeList({ outcome, onDismiss }: { outcome: Outcome[]; onDismiss: () => void }) {
  return (
    <div className="outcome-banner" role="status">
      <ul>
        {outcome.map((r) => (
          <li key={r.id} className={`outcome ${r.status}`}>
            <strong>{r.status}</strong> {r.id}
            {r.message && <span className="muted"> — {r.message}</span>}
            {"warnings" in r &&
              r.warnings.map((w) => (
                <div key={w} className="warn">
                  {w}
                </div>
              ))}
            {"checks" in r && r.checks && <Checks checks={r.checks} />}
          </li>
        ))}
      </ul>
      <button type="button" className="ghost icon" aria-label={t("setup.plan.dismiss")} onClick={onDismiss}>
        <X size={14} />
      </button>
    </div>
  );
}
