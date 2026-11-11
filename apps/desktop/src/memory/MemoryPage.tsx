import type { MemoryProject, Methods } from "@agentchainer/protocol";
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  ExternalLink,
  FileText,
  FolderX,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { count, dateTime } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { request } from "../sidecar.ts";
import { folderName } from "../tabs.ts";
import { approxTokens, sortProjects } from "./memory.ts";

type Scan = Methods["memory.scan"]["result"];

const STATUS: Record<MemoryProject["status"], { tone: string; icon: ReactNode; label: () => string }> = {
  ok: { tone: "tone-ok", icon: <CircleCheck size={12} />, label: () => t("setup.memoryPage.statusOk") },
  long: { tone: "tone-warn", icon: <CircleAlert size={12} />, label: () => t("setup.memoryPage.statusLong") },
  noTest: { tone: "tone-warn", icon: <CircleAlert size={12} />, label: () => t("setup.memoryPage.statusNoTest") },
  missing: { tone: "tone-err", icon: <CircleX size={12} />, label: () => t("setup.memoryPage.statusMissing") },
  refused: { tone: "tone-err", icon: <CircleHelp size={12} />, label: () => t("setup.memoryPage.statusRefused") },
  gone: { tone: "", icon: <FolderX size={12} />, label: () => t("setup.memoryPage.statusGone") },
};

/** Why a status is what it is, in a few words, for the row's second line. */
function detailOf(p: MemoryProject): string | null {
  if (p.status === "long") return t("setup.memoryPage.detailLong", { lines: count(p.file?.lines ?? 0) });
  if (p.status === "noTest") return t("setup.memoryPage.detailNoTest", { command: p.testCommand ?? "" });
  if (p.status === "refused") return p.file?.refused ?? null;
  return null;
}

/**
 * CLAUDE.md (CP-03): the CLAUDE.md of every project the app knows, checked the way the setup check does, and the
 * user's own. A row opens that project's Workspace settings on CLAUDE.md, where it's edited. Nothing is sent anywhere.
 */
export function MemoryPage({
  workspaces,
  onOpen,
  onOpenFile,
}: {
  workspaces: string[];
  onOpen: (cwd: string) => void;
  onOpenFile: (file: string) => Promise<void>;
}) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = workspaces.join("\n");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    request("memory.scan", { workspaces: key ? key.split("\n") : [] }).then(
      (r) => {
        setScan(r);
        setLoading(false);
      },
      (err: unknown) => {
        setError(String(err instanceof Error ? err.message : err));
        setLoading(false);
      },
    );
  }, [key]);
  useEffect(load, [load]);

  const user = scan?.user;
  return (
    <div className="usage-page memory-page">
      <header className="usage-header">
        <FileText size={18} aria-hidden />
        <h1>{t("setup.memoryPage.title")}</h1>
        <span className="grow" />
        <button
          type="button"
          className="ghost small"
          onClick={load}
          disabled={loading}
          aria-label={t("setup.memoryPage.refresh")}
        >
          {loading ? <Loader2 size={14} className="spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
        </button>
      </header>
      <p className="muted usage-note">{t("setup.memoryPage.note")}</p>
      {error && (
        <p className="usage-note error" role="alert">
          {error}
        </p>
      )}
      {!scan && loading && <p className="muted usage-note">{t("setup.memoryPage.loading")}</p>}

      {user && (
        <section className="card memory-user" aria-labelledby="memory-user">
          <div className="card-title">
            <h2 id="memory-user" className="usage-card-heading">
              {t("setup.memoryPage.userTitle")}
            </h2>
            <span className="grow" />
            {user.exists && user.absolute && !user.refused && (
              <button
                type="button"
                className="secondary small"
                onClick={() => void onOpenFile(user.absolute ?? "").catch((err) => setError(String(err)))}
              >
                <ExternalLink size={13} aria-hidden />
                {t("setup.memoryPage.openInEditor")}
              </button>
            )}
          </div>
          <p className="memory-user-line">
            <code>{user.path}</code>{" "}
            <span className="muted">
              {user.refused
                ? user.refused
                : user.exists
                  ? t("setup.memory.size", { lines: count(user.lines), tokens: count(approxTokens(user.bytes)) })
                  : t("setup.memoryPage.userNone")}
            </span>
          </p>
          <p className="field-help">{t("setup.memoryPage.userHelp")}</p>
        </section>
      )}

      {scan && scan.projects.length === 0 && <p className="muted usage-note">{t("setup.memoryPage.empty")}</p>}
      {scan && scan.projects.length > 0 && (
        <section className="card" aria-labelledby="memory-projects">
          <h2 id="memory-projects" className="usage-card-heading">
            {t("setup.memoryPage.projects")}
          </h2>
          <table className="metrics-table memory-table">
            <thead>
              <tr>
                <th scope="col">{t("setup.memoryPage.project")}</th>
                <th scope="col">{t("setup.memoryPage.status")}</th>
                <th scope="col">{t("setup.memoryPage.lines")}</th>
                <th scope="col">{t("setup.memoryPage.tokens")}</th>
                <th scope="col">{t("setup.memoryPage.changed")}</th>
              </tr>
            </thead>
            <tbody>
              {sortProjects(scan.projects).map((p) => {
                const s = STATUS[p.status];
                const detail = detailOf(p);
                const extra = [
                  p.folders ? t("setup.memoryPage.inFolders", { count: p.folders }) : null,
                  p.local ? t("setup.memoryPage.personal") : null,
                ].filter(Boolean);
                return (
                  <tr key={p.cwd}>
                    <th scope="row">
                      {p.status === "gone" ? (
                        <span className="memory-project" title={p.cwd}>
                          {folderName(p.cwd)}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="link memory-project"
                          title={p.cwd}
                          onClick={() => onOpen(p.cwd)}
                        >
                          {folderName(p.cwd)}
                        </button>
                      )}
                      <span className="usage-sub muted">
                        {[p.file?.path, ...extra].filter(Boolean).join(" · ") || p.cwd}
                      </span>
                    </th>
                    <td>
                      <span className={`badge mcp-status ${s.tone}`}>
                        {s.icon}
                        {s.label()}
                      </span>
                      {detail && <span className="usage-sub muted">{detail}</span>}
                    </td>
                    <td>{p.file?.exists && !p.file.refused ? count(p.file.lines) : "—"}</td>
                    <td>
                      {p.file?.exists && !p.file.refused
                        ? t("setup.memoryPage.aboutTokens", { n: count(approxTokens(p.file.bytes)) })
                        : "—"}
                    </td>
                    <td>{p.file?.modifiedAt ? dateTime(p.file.modifiedAt) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
