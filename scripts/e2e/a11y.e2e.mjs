// X-12: accessibility checks in the running app, through WebDriver. axe-core audits the main screens in light and in
// dark (WCAG 2.1 A and AA); serious and critical violations fail, the rest is written to a11y-report.json. Then
// keyboard-only flows: the palette by its shortcut, Tab through the sidebar with a visible focus ring, and a dialog
// that keeps focus inside. Run by scripts/e2e/run.mjs after app.e2e.mjs, in its own app session.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { axeViolations } from "./axe.mjs";
import { KEY, WebDriver, waitFor, xpathString } from "./webdriver.mjs";

const binary = process.env.AC_E2E_BINARY ?? "";
const workspace = process.env.AC_E2E_WORKSPACE ?? "";
const artifacts = process.env.AC_E2E_ARTIFACTS ?? ".";

const app = new WebDriver();
/** Every audit's violations, by screen and theme. */
const report = {};
const blocking = [];

/** Audits the current screen in both themes, then puts the theme back. */
async function audit(screen) {
  const saved = await app.execute("return document.documentElement.dataset.theme ?? '';");
  report[screen] = {};
  for (const theme of ["light", "dark"]) {
    // Contrast is measured at the end state: fade-ins and colour transitions are finished first (WebKitGTK under Xvfb
    // runs them slowly). Spinners repeat forever and can't be finished.
    await app.execute(
      `document.documentElement.dataset.theme = arguments[0];
      for (const a of document.getAnimations()) try { a.finish(); } catch {}`,
      [theme],
    );
    const violations = await axeViolations(app);
    report[screen][theme] = violations;
    for (const v of violations) {
      if (v.impact === "serious" || v.impact === "critical") blocking.push(`${screen} (${theme}): ${v.id} ${v.help}`);
    }
  }
  await app.execute("document.documentElement.dataset.theme = arguments[0];", [saved]);
}

const nav = (label) =>
  app.find(`//nav[@aria-label='Setup sections']//button[contains(normalize-space(.), ${xpathString(label)})]`);

/** A short description of the focused element, for keyboard checks. */
const focused = () =>
  app.execute(`
    const e = document.activeElement;
    if (!e || e === document.body) return null;
    const style = getComputedStyle(e);
    return {
      name: (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 40),
      tag: e.tagName,
      cls: e.getAttribute("class") ?? "",
      inDialog: !!e.closest("[role=dialog], [role=alertdialog]"),
      ring: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 || style.boxShadow !== "none",
    };`);

describe("accessibility (X-12)", () => {
  before(async () => {
    assert.ok(binary && workspace, "run through scripts/e2e/run.mjs");
    await app.start(binary, process.env.AC_E2E_DEBUGGER);
    // Home, whatever the app shows: on Windows this session attaches to the instance the other flows used.
    await app.chord(KEY.escape);
    await (
      await app.find("//nav[@aria-label='Sessions and workspaces']//button[contains(normalize-space(.), 'New')]", {
        timeout: 120_000,
      })
    ).click();
    // New opens the New session dialog over Home (UX-20): its audit comes first, then Escape closes it.
    await app.find("//*[@role='dialog']//form[@id='new-session-form']", { timeout: 60_000 });
    await audit("new-session-dialog");
    await app.chord(KEY.escape);
    await waitFor(async () => (await app.findAll("//*[@role='dialog']")).length === 0, {
      what: "the New session dialog to close",
    });
    await app.find("//section[contains(@class, 'readiness')]", { timeout: 60_000 });
  });
  after(async () => {
    writeFileSync(path.join(artifacts, "a11y-report.json"), `${JSON.stringify({ blocking, report }, null, 2)}\n`);
    await app.stop();
  });

  it("audits Home", () => audit("home"));

  it("audits Workspace settings", async () => {
    await (
      await app.find(
        `//nav[@aria-label='Sessions and workspaces']//button[contains(@class, 'workspace')][.//*[normalize-space(.)=${xpathString(path.basename(workspace))}]]`,
      )
    ).click();
    await (await app.button("Workspace settings…", { timeout: 60_000 })).click();
    await app.findText("Workspace settings", { tag: "h1" });
    await audit("workspace-overview");
    await (await nav("Setup plan")).click();
    await app.find("//div[contains(@class, 'plan-list')]//input[@type='checkbox']", { timeout: 60_000 });
    await audit("setup-plan");
    await (await nav("Commands")).click();
    await audit("commands");
    // CP-04: what each task's worktree gets.
    await (await nav("Worktrees")).click();
    await app.find("//section[contains(@class, 'worktree-card')]", { timeout: 60_000 });
    await audit("worktrees");
    // CP-03: the CLAUDE.md editor (Monaco loads lazily) beside its preview.
    await (await nav("CLAUDE.md")).click();
    await app.find("//section[contains(@class, 'memory-detail')]", { timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 1500));
    await audit("claude-md");
    await (await nav("Plugins")).click();
    await new Promise((r) => setTimeout(r, 1500));
    await audit("plugins");
    // CP-02: the list asks the CLI, which checks each server; without a CLI the page shows why.
    await (await nav("MCP servers")).click();
    await new Promise((r) => setTimeout(r, 1500));
    await audit("mcp-servers");
    await (await nav("History")).click();
    await audit("history");
  });

  it("audits a confirm dialog", async () => {
    await (await nav("Setup plan")).click();
    const apply = await app.find("//button[contains(normalize-space(.), 'Apply selected')]");
    await apply.click();
    await app.find("//*[@role='dialog' or @role='alertdialog']");
    await audit("confirm-dialog");
    await app.chord(KEY.escape);
  });

  it("audits Settings and the command palette", async () => {
    await (await app.find("//nav[@aria-label='Sessions and workspaces']//button[@aria-label='Settings']")).click();
    await app.find("//*[@role='dialog']");
    await audit("settings-dialog");
    await app.chord(KEY.escape);
    await waitFor(async () => (await app.findAll("//*[@role='dialog']")).length === 0, { what: "Settings to close" });
    await (await app.find("button.titlebar-search")).click();
    await app.find("//input[@role='combobox']");
    await audit("command-palette");
    await app.chord(KEY.escape);
  });

  it("audits the CLAUDE.md page (CP-03)", async () => {
    await (
      await app.find(
        "//nav[@aria-label='Sessions and workspaces']//button[contains(@class, 'fleet-entry')][contains(normalize-space(.), 'CLAUDE.md')]",
      )
    ).click();
    await app.find("//section[contains(@class, 'memory-user')]", { timeout: 60_000 });
    await audit("claude-md-page");
  });

  it("opens the palette from the keyboard, and Escape gives focus back", async () => {
    const opener = await app.find(
      "//nav[@aria-label='Sessions and workspaces']//button[contains(normalize-space(.), 'New')]",
    );
    await app.execute("arguments[0].focus();", [opener.ref]);
    const before = await focused();
    await app.chord(KEY.control, KEY.shift, "p");
    await waitFor(async () => (await focused())?.tag === "INPUT", { what: "the palette's input to take focus" });
    await app.chord(KEY.escape);
    await waitFor(async () => (await app.findAll("//input[@role='combobox']")).length === 0, {
      what: "the palette to close",
    });
    assert.equal((await focused())?.name, before?.name, "focus goes back to where it was");
  });

  it("reaches the sidebar by Tab, with a visible focus ring on each stop", async () => {
    // From the top of the page. blur() isn't enough: Chromium (WebView2) goes on tabbing from where focus was.
    await app.execute(
      `document.querySelector("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])")?.focus();`,
    );
    const stops = [];
    for (let i = 0; i < 30; i++) {
      await app.chord(KEY.tab);
      const f = await focused();
      if (f) stops.push(f);
    }
    const names = stops.map((s) => s.name);
    assert.ok(
      names.some((n) => n.startsWith("New")),
      `Tab reached New: ${names.join(" | ")}`,
    );
    assert.ok(names.includes("Settings"), `Tab reached Settings: ${names.join(" | ")}`);
    const bare = stops.filter((s) => !s.ring).map((s) => `${s.tag}.${s.cls} "${s.name}"`);
    assert.deepEqual(bare, [], "every Tab stop shows a focus ring");
  });

  it("keeps focus inside a dialog until Escape closes it", async () => {
    await (await app.find("//nav[@aria-label='Sessions and workspaces']//button[@aria-label='Settings']")).click();
    await app.find("//*[@role='dialog']");
    for (let i = 0; i < 20; i++) {
      await app.chord(KEY.tab);
      assert.equal((await focused())?.inDialog, true, `Tab ${i + 1} left the dialog`);
    }
    await app.chord(KEY.escape);
    await waitFor(async () => (await app.findAll("//*[@role='dialog']")).length === 0, { what: "the dialog to close" });
  });

  it("has no serious or critical violations", () => {
    assert.deepEqual(blocking, [], `see ${path.join(artifacts, "a11y-report.json")}`);
  });
});
