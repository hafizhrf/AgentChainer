import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { resultEnglish, resultText, setLanguage } from "@agentchainer/protocol";
import { type ScanResult, semgrepScan, trivyScan } from "./scanners.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const repo = (semgrepConfig = false) => {
  const d = mkdtempSync(join(tmpdir(), "ac-scan-"));
  dirs.push(d);
  if (semgrepConfig) writeFileSync(join(d, ".semgrep.yml"), "rules: []\n");
  return d;
};
const exec = (status: number | null, stdout: string, stderr = "") => {
  const calls: string[][] = [];
  const fn = async (_bin: string, args: string[]) => {
    calls.push(args);
    return { status, stdout, stderr };
  };
  return Object.assign(fn, { calls });
};
/** The result in English, checking that its ref says the same (X-13 part 2b). */
const english = (r: ScanResult) => {
  if (r.ran) {
    const { detailRef, ...rest } = r;
    assert.equal(resultEnglish(detailRef), r.detail);
    return rest;
  }
  const { whyRef, ...rest } = r;
  assert.equal(resultEnglish(whyRef), r.why);
  return rest;
};

describe("merge-gate scanners, offline only (M5-04)", () => {
  it("runs semgrep only with the repository's own rules, never registry ones", async () => {
    assert.deepEqual(english(await semgrepScan(repo(), ["a.js"], null)), {
      ran: false,
      why: "semgrep isn't installed",
    });
    const none = await semgrepScan(repo(), ["a.js"], "semgrep", exec(0, "{}"));
    assert.equal(none.ran, false);
    const found = exec(1, JSON.stringify({ results: [{}, {}] }));
    const r = await semgrepScan(repo(true), ["a.js"], "semgrep", found);
    assert.deepEqual(english(r), { ran: true, findings: 2, detail: "2 findings (.semgrep.yml)." });
    assert.ok(found.calls[0]?.includes("--metrics=off") && !found.calls[0]?.includes("auto"));
    assert.equal((await semgrepScan(repo(true), ["a.js"], "semgrep", exec(2, "", "bad config"))).ran, false);
  });

  it("runs trivy offline, and says so when its database isn't on this machine", async () => {
    const clean = exec(0, JSON.stringify({ Results: [] }));
    assert.deepEqual(english(await trivyScan(repo(), "trivy", clean)), {
      ran: true,
      findings: 0,
      detail: "Nothing found.",
    });
    for (const flag of ["--offline-scan", "--skip-db-update", "--skip-java-db-update"]) {
      assert.ok(clean.calls[0]?.includes(flag), flag);
    }
    const found = exec(3, JSON.stringify({ Results: [{ Vulnerabilities: [{}], Secrets: [{}] }] }));
    assert.deepEqual(english(await trivyScan(repo(), "trivy", found)), {
      ran: true,
      findings: 2,
      detail: "2 findings.",
    });
    const noDb = await trivyScan(repo(), "trivy", exec(1, "", "FATAL the first run cannot skip downloading DB"));
    assert.deepEqual(english(noDb), {
      ran: false,
      why: "trivy didn't run offline: FATAL the first run cannot skip downloading DB",
    });
  });

  it("says why a scanner didn't run in the app's language too, from the same template (X-13)", async () => {
    const failed = await semgrepScan(repo(true), ["a.js"], "semgrep", exec(2, ""));
    assert.deepEqual(english(failed), { ran: false, why: "semgrep failed: exit 2" });
    await setLanguage("id");
    try {
      assert.ok(!failed.ran);
      assert.equal(resultText(failed.whyRef), "semgrep gagal: exit 2");
    } finally {
      await setLanguage("en");
    }
  });
});
