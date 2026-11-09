import { existsSync } from "node:fs";
import path from "node:path";
import { type MessageRef, resultRef } from "@agentchainer/protocol";
import { findTool, toolsDir } from "../bootstrap/tools.ts";
import { runAsync } from "../run-async.ts";
import { result } from "./result.ts";

/**
 * semgrep and trivy as merge gates (M5-04, docs/design/git-workflow.md §7), only when the user has them installed, and
 * only offline: neither downloads rules or a vulnerability database from here. They aren't in the catalog; pinning them
 * later follows ADR-0005.
 */

/** `detail` and `why` in English, and their refs for the app's language (X-13 part 2b). */
export type ScanResult =
  | { ran: true; findings: number; detail: string; detailRef: MessageRef }
  | { ran: false; why: string; whyRef: MessageRef };

type Text = ReturnType<typeof result>;
const found = (findings: number, detail: Text): ScanResult => ({
  ran: true,
  findings,
  detail: detail.text,
  detailRef: detail.ref,
});
const notRun = (why: Text): ScanResult => ({ ran: false, why: why.text, whyRef: why.ref });

/** The repository's own semgrep rules; registry rules (`--config auto`, `p/...`) would need the network. */
const SEMGREP_CONFIGS = [".semgrep.yml", ".semgrep.yaml", ".semgrep"];

type Run = (
  bin: string,
  args: string[],
  cwd: string,
) => Promise<{ status: number | null; stdout: string; stderr: string }>;

/** Scanners can take minutes on a big repository: never blocking the sidecar (`runAsync`). */
const run: Run = (bin, args, cwd) => runAsync(bin, args, { cwd, timeoutMs: 300_000 });

const firstLine = (text: string) => text.trim().split("\n")[0]?.slice(0, 200) ?? "";

/** What a scanner that failed said, or its exit code when it said nothing. */
const failure = (r: { status: number | null; stdout: string; stderr: string }) =>
  firstLine(r.stderr || r.stdout) || resultRef("evidence.gate.exit", { code: String(r.status) });

/** semgrep over the changed files, with the repository's own config. Exit 1 with `--error` means findings. */
export async function semgrepScan(
  code: string,
  files: string[],
  bin = findTool("semgrep", toolsDir()),
  exec: Run = run,
): Promise<ScanResult> {
  if (!bin) return notRun(result("evidence.scan.notInstalled", { tool: "semgrep" }));
  const config = SEMGREP_CONFIGS.find((c) => existsSync(path.join(code, c)));
  if (!config) return notRun(result("evidence.scan.semgrepNoConfig"));
  if (!files.length) return found(0, result("evidence.scan.noFiles"));
  const r = await exec(
    bin,
    ["scan", "--metrics=off", "--disable-version-check", "--config", config, "--json", "--error", "--quiet", ...files],
    code,
  );
  if (r.status !== 0 && r.status !== 1) {
    return notRun(result("evidence.scan.failed", { tool: "semgrep", error: failure(r) }));
  }
  let findings = 0;
  try {
    findings = (JSON.parse(r.stdout) as { results?: unknown[] }).results?.length ?? 0;
  } catch {
    return notRun(result("evidence.scan.unreadable", { tool: "semgrep" }));
  }
  return found(
    findings,
    findings
      ? result("evidence.scan.foundIn", { count: findings, config })
      : result("evidence.scan.cleanIn", { config }),
  );
}

/**
 * trivy over the code folder, offline: its database must already be on this machine (`trivy` downloads it on first
 * use when the user runs it). Exit 3 means findings; any other failure means it didn't run.
 */
export async function trivyScan(
  code: string,
  bin = findTool("trivy", toolsDir()),
  exec: Run = run,
): Promise<ScanResult> {
  if (!bin) return notRun(result("evidence.scan.notInstalled", { tool: "trivy" }));
  const r = await exec(
    bin,
    [
      "fs",
      "--offline-scan",
      "--skip-db-update",
      "--skip-java-db-update",
      "--skip-check-update",
      "--scanners",
      "vuln,secret,misconfig",
      "--exit-code",
      "3",
      "--quiet",
      "--format",
      "json",
      ".",
    ],
    code,
  );
  if (r.status !== 0 && r.status !== 3) {
    return notRun(result("evidence.scan.trivyOffline", { error: failure(r) }));
  }
  let findings = 0;
  try {
    const report = JSON.parse(r.stdout || "{}") as {
      Results?: { Vulnerabilities?: unknown[]; Secrets?: unknown[]; Misconfigurations?: unknown[] }[];
    };
    for (const x of report.Results ?? []) {
      findings += (x.Vulnerabilities?.length ?? 0) + (x.Secrets?.length ?? 0) + (x.Misconfigurations?.length ?? 0);
    }
  } catch {
    return notRun(result("evidence.scan.unreadable", { tool: "trivy" }));
  }
  return found(findings, findings ? result("evidence.scan.found", { count: findings }) : result("evidence.scan.clean"));
}
