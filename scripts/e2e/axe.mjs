// X-12: axe-core in the running app, for the E2E files that audit a screen. Injected through WebDriver once per page;
// WCAG 2.1 A and AA rules.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

/** The current screen's violations: id, impact, help, and up to 8 failing elements. */
export async function axeViolations(app) {
  if (!(await app.execute("return typeof window.axe === 'object';"))) await app.execute(`${axeSource}; return true;`);
  return app.execute(`
    return window.axe
      .run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] })
      .then((r) => r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.slice(0, 8).map((n) => ({ target: n.target.join(" "), summary: n.failureSummary })),
      })));`);
}

/** Serious and critical violations fail a run; the rest are reported. */
export const blocking = (violations) => violations.filter((v) => v.impact === "serious" || v.impact === "critical");
