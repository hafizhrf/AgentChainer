// X-13: the app in the pseudo-locale (AGENTCHAINER_PSEUDO_LOCALE=1, set by run.mjs for this file's phase). Every catalog
// message renders accented and in ⟦brackets⟧, so text in the app's own chrome that bypassed the catalogs is the text
// without them. The test finds its way by the same messages, computed here from the catalogs, and saves screenshots
// of the main screens. Prose from the sidecar and data (workspace names, paths, model names) aren't checked.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setPseudo, t } from "../../apps/desktop/src/i18n/index.ts";
import { KEY, WebDriver, waitFor, xpathString } from "./webdriver.mjs";

const binary = process.env.AC_E2E_BINARY ?? "";
const workspace = process.env.AC_E2E_WORKSPACE ?? "";
const artifacts = process.env.AC_E2E_ARTIFACTS ?? ".";

setPseudo(true);
const app = new WebDriver();

/**
 * Visible text in `root` that didn't come from a catalog: no ⟦⟧ and no accented letter (a `<Rich>` message is split
 * into parts, and only its first and last carry the brackets). Code, commands and keys are skipped, and so is
 * `allowed` data.
 */
const unmarked = (root, allowed) =>
  app.execute(
    `
    const [selector, allowed] = arguments;
    const marked = /[⟦⟧åçéĝîķñöŕšţüýÅÇÉÎÑÖŠÜ]/;
    const keys = /^(Ctrl|Shift|Alt|Esc|Enter|Tab|⌘|⇧|⌥|\\+|\\s|[A-Z0-9,.\\\\/])+$/;
    const out = [];
    for (const el of document.querySelectorAll(selector)) {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const text = n.textContent.trim();
        const parent = n.parentElement;
        if (!/[A-Za-z]{2}/.test(text) || marked.test(text) || keys.test(text)) continue;
        if (!parent || parent.closest("code, kbd, pre") || !parent.getClientRects().length) continue;
        if (allowed.some((a) => text.includes(a))) continue;
        out.push(text.slice(0, 60) + "  [" + parent.tagName.toLowerCase() + "." + (parent.className || "") + "]");
      }
    }
    return out;`,
    [root, allowed],
  );

async function shot(name) {
  writeFileSync(path.join(artifacts, `pseudo-${name}.png`), await app.screenshot());
}

describe("pseudo-locale (X-13)", () => {
  const data = [path.basename(workspace), workspace, "AgentChainer"];

  before(async () => {
    assert.ok(binary && workspace, "run through scripts/e2e/run.mjs");
    await app.start(binary, process.env.AC_E2E_DEBUGGER);
    await app.find("nav.sidebar", { timeout: 120_000 });
  });
  after(() => app.stop());

  it("runs in the pseudo-locale, and says so in <html lang>", async () => {
    // Without this, every other check here would pass on plain English.
    await app.find(`//nav[contains(@class, 'sidebar')]//*[contains(., ${xpathString(t("shell.sidebar.newSession"))})]`);
    assert.equal(await app.execute("return document.documentElement.lang;"), "en");
  });

  it("shows only catalog text in the title bar, the sidebar and the setup check on Home", async () => {
    await app.find("section.readiness", { timeout: 60_000 });
    await shot("home");
    assert.deepEqual(await unmarked(".titlebar, nav.sidebar, section.readiness", data), []);
  });

  it("shows only catalog text in Settings", async () => {
    await (await app.button(t("shell.sidebar.settings"))).click();
    await app.find("//*[@role='dialog']");
    await shot("settings");
    assert.deepEqual(await unmarked("[role=dialog]", data), []);
    await app.chord(KEY.escape);
    await waitFor(async () => (await app.findAll("//*[@role='dialog']")).length === 0, { what: "Settings to close" });
  });

  it("shows only catalog text in Workspace settings' navigation", async () => {
    await (
      await app.find(
        `//nav[contains(@class, 'sidebar')]//button[contains(@class, 'workspace')][.//*[normalize-space(.)=${xpathString(path.basename(workspace))}]]`,
      )
    ).click();
    await (await app.button(t("home.view.openSetup"), { timeout: 60_000 })).click();
    await app.findText(t("setup.page.title"), { tag: "h1" });
    await shot("workspace-settings");
    assert.deepEqual(await unmarked("nav.setup-nav, .setup-page h1", data), []);
  });

  it("shows only catalog text in the command palette", async () => {
    await app.chord(KEY.control, KEY.shift, "p");
    await app.find("//input[@role='combobox']");
    await shot("palette");
    assert.deepEqual(await unmarked(".palette", data), []);
    await app.chord(KEY.escape);
  });
});
