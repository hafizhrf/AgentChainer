import type { Methods } from "@agentchainer/protocol";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { t } from "../i18n/index.ts";
import { FileIcon } from "../ui/FileIcon.tsx";
import { EmptyState } from "../ui/Section.tsx";

type Profile = Methods["workspace.scan"]["result"]["profile"];

/** The manifest each stack is detected from, for its icon. */
const MANIFEST: Record<Profile["packages"][number]["stack"], string> = {
  node: "package.json",
  python: "pyproject.toml",
  flutter: "pubspec.yaml",
  dart: "pubspec.yaml",
  go: "go.mod",
  rust: "Cargo.toml",
};

/** Packages found in the workspace and the commands detected for each (M2-07), with where each came from. */
export function Commands({ profile }: { profile: Profile }) {
  return (
    <div className="setup-scroll">
      {profile.packages.length === 0 && <EmptyState>{t("setup.commands.empty")}</EmptyState>}
      {profile.packages.map((p) => (
        <section key={`${p.path}-${p.stack}`} className="card package-card">
          <header className="package-head">
            <FileIcon path={MANIFEST[p.stack]} size={18} />
            <div>
              <strong>{p.path === "." ? t("setup.commands.workspaceRoot") : p.path}</strong>
              <span className="muted">
                {p.stack} · {p.packageManager}
                {p.frameworks.length > 0 && ` · ${p.frameworks.join(", ")}`}
              </span>
            </div>
          </header>
          <table className="command-table">
            <tbody>
              {Object.entries(p.commands).map(([kind, c]) =>
                c ? (
                  <tr key={kind}>
                    <th scope="row">{kind}</th>
                    <td>
                      <code title={t("setup.commands.from", { source: c.source })}>{c.run}</code>
                    </td>
                    <td>
                      {c.confidence !== "high" && (
                        <span className="badge">{t("setup.commands.confidence", { confidence: c.confidence })}</span>
                      )}
                    </td>
                    <td>
                      <CopyButton text={c.run} />
                    </td>
                  </tr>
                ) : null,
              )}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost icon"
      aria-label={copied ? t("setup.commands.copied") : t("setup.commands.copyText", { text })}
      title={copied ? t("setup.commands.copied") : t("setup.commands.copy")}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
