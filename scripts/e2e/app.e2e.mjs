// X-06: end-to-end flows that need no Claude login, driven through tauri-driver. Run by scripts/e2e/run.mjs, which
// sets up the temporary workspace and settings this reads from the environment. One app session, flows in order.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { KEY, WebDriver, waitFor, xpathString } from "./webdriver.mjs";

const binary = process.env.AC_E2E_BINARY ?? "";
const workspace = process.env.AC_E2E_WORKSPACE ?? "";
const settingsFile = process.env.AC_E2E_SETTINGS ?? "";
const artifacts = process.env.AC_E2E_ARTIFACTS ?? ".";
const gitignore = path.join(workspace, ".gitignore");

const app = new WebDriver();

/** Runs a flow; on failure saves a screenshot named after it, then fails. */
async function flow(name, body) {
  try {
    await body();
  } catch (err) {
    const png = await app.screenshot().catch(() => null);
    if (png) writeFileSync(path.join(artifacts, `${name}.png`), png);
    throw err;
  }
}

/** The confirm dialog's button, once the dialog is open. */
const confirmIn = (label) =>
  app.find(`//*[@role='dialog' or @role='alertdialog']//button[normalize-space(.)=${xpathString(label)}]`);

describe("AgentChainer end to end (X-06)", () => {
  before(async () => {
    assert.ok(binary && workspace && settingsFile, "run through scripts/e2e/run.mjs");
    await app.start(binary);
  });
  after(() => app.stop());

  it("starts and shows the setup check", () =>
    flow("1-start", async () => {
      // The Linux runner can take ~30 s before the app's own code runs (docs/PERFORMANCE.md).
      const check = await app.find("//section[@aria-label='Setup check']", { timeout: 120_000 });
      await waitFor(async () => (await check.text()).includes("Claude Code CLI"), {
        timeout: 60_000,
        what: "the Claude CLI row of the setup check",
      });
    }));

  it("opens the recent workspace from the sidebar, then its settings", () =>
    flow("2-workspace", async () => {
      const recent = await app.find(
        `//nav[@aria-label='Sessions and workspaces']//button[@title=${xpathString(workspace)}]`,
      );
      await recent.click();
      // Shown once the runtime is connected and the folder is known.
      await (await app.button("Workspace settings…", { timeout: 60_000 })).click();
      await app.findText("Workspace settings", { tag: "h1" });
    }));

  it("applies a setup fix, and History rolls it back byte for byte", () =>
    flow("3-setup", async () => {
      assert.equal(existsSync(gitignore), false, "the fixture has no .gitignore");
      await (
        await app.find("//nav[@aria-label='Setup sections']//button[contains(normalize-space(.), 'Setup plan')]")
      ).click();
      const target = "Include Ignore env and secret files";
      await app.find(`//input[@type='checkbox'][@aria-label=${xpathString(target)}]`, { timeout: 60_000 });
      // Only the fix: catalog plugins need a Claude CLI, which this runner doesn't have.
      for (const box of await app.findAll("//div[contains(@class, 'plan-list')]//input[@type='checkbox']")) {
        const label = await box.attribute("aria-label");
        const on = await box.selected();
        if (on !== (label === target) && (await box.attribute("disabled")) === null) await box.click();
      }
      await (await app.find("//button[contains(normalize-space(.), 'Apply selected (1)')]")).click();
      await (await confirmIn("Apply")).click();
      await waitFor(() => existsSync(gitignore) && readFileSync(gitignore, "utf8").includes(".env"), {
        timeout: 60_000,
        what: "the fix to write .gitignore",
      });

      await (
        await app.find("//nav[@aria-label='Setup sections']//button[contains(normalize-space(.), 'History')]")
      ).click();
      await (await app.button("Roll back run", { timeout: 30_000 })).click();
      await (await confirmIn("Roll back")).click();
      await waitFor(() => !existsSync(gitignore), { timeout: 60_000, what: "Roll back to remove .gitignore" });
    }));

  it("opens a Workspace settings section from the command palette", () =>
    flow("4-palette", async () => {
      await (await app.find("button.titlebar-search")).click();
      const input = await app.find("//input[@role='combobox']");
      await input.type("Workspace settings: Commands");
      await app.findText("Workspace settings: Commands");
      await input.type(KEY.enter);
      await app.find(
        "//nav[@aria-label='Setup sections']//button[@aria-current='page'][contains(normalize-space(.), 'Commands')]",
      );
    }));

  it("saves the theme in Settings", () =>
    flow("5-settings", async () => {
      await (await app.find("//nav[@aria-label='Sessions and workspaces']//button[@aria-label='Settings']")).click();
      await (await app.find("//button[@aria-label='Theme']")).click();
      await (await app.find("//*[@role='option'][normalize-space(.)='Dark']")).click();
      await (await app.button("Save")).click();
      await waitFor(() => JSON.parse(readFileSync(settingsFile, "utf8")).theme === "dark", {
        what: "settings.json to say the theme is dark",
      });
      assert.equal(await app.execute("return document.documentElement.dataset.theme;"), "dark");
    }));
});
