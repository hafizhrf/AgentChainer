// X-13: the app in Bahasa Indonesia, chosen in its settings (run.mjs's last phase sets `language: "id"`). It checks the
// language reaches the page and the dialogs, audits the main screens with axe (serious and critical violations fail),
// and saves `id-*.png` screenshots, so the translation can be read where it's shown. Labels are computed here from the
// same catalogs.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { LANGUAGES, setLocale, t } from "../../apps/desktop/src/i18n/index.ts";
import { axeViolations, blocking } from "./axe.mjs";
import { KEY, WebDriver, waitFor, xpathString } from "./webdriver.mjs";

const binary = process.env.AC_E2E_BINARY ?? "";
const workspace = process.env.AC_E2E_WORKSPACE ?? "";
const artifacts = process.env.AC_E2E_ARTIFACTS ?? ".";

await setLocale("id");
const app = new WebDriver();

/** Saves a screenshot and returns the screen's serious and critical violations, as "id: help". */
async function look(name) {
  await app.execute("for (const a of document.getAnimations()) try { a.finish(); } catch {}");
  writeFileSync(path.join(artifacts, `id-${name}.png`), await app.screenshot());
  return blocking(await axeViolations(app)).map((v) => `${v.id}: ${v.help}`);
}

describe("Bahasa Indonesia (X-13)", () => {
  before(async () => {
    assert.ok(binary && workspace, "run through scripts/e2e/run.mjs");
    await app.start(binary, process.env.AC_E2E_DEBUGGER);
    await app.find("nav.sidebar", { timeout: 120_000 });
  });
  after(() => app.stop());

  it("draws the UI in Indonesian, and says so in <html lang>", async () => {
    await app.find(`//nav[@aria-label=${xpathString(t("shell.sidebar.label"))}]`);
    assert.equal(await app.execute("return document.documentElement.lang;"), "id");
    await app.find("section.readiness", { timeout: 60_000 });
    assert.deepEqual(await look("home"), []);
  });

  it("shows Bahasa Indonesia as the language in Settings", async () => {
    await (await app.button(t("shell.sidebar.settings"))).click();
    await app.findText(t("home.settings.title"));
    await app.find(
      `//*[@aria-label=${xpathString(t("home.settings.language"))}][contains(., ${xpathString(LANGUAGES.id)})]`,
    );
    const found = await look("settings");
    // Closed before the check, so a failure here doesn't block the next screens.
    await app.chord(KEY.escape);
    await waitFor(async () => (await app.findAll("//*[@role='dialog']")).length === 0, { what: "Settings to close" });
    assert.deepEqual(found, []);
  });

  it("opens Workspace settings in Indonesian", async () => {
    await (
      await app.find(
        `//nav[contains(@class, 'sidebar')]//button[contains(@class, 'workspace')][.//*[normalize-space(.)=${xpathString(path.basename(workspace))}]]`,
      )
    ).click();
    await (await app.button(t("home.view.openSetup"), { timeout: 60_000 })).click();
    await app.findText(t("setup.page.title"), { tag: "h1" });
    assert.deepEqual(await look("workspace-settings"), []);
  });

  it("opens the command palette in Indonesian", async () => {
    await app.chord(KEY.control, KEY.shift, "p");
    await app.find(`//input[@role='combobox']`);
    assert.deepEqual(await look("palette"), []);
    await app.chord(KEY.escape);
  });
});
