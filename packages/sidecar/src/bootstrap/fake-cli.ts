import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliResult } from "../installer.ts";
import type { Cli } from "./apply.ts";

/** Test helper: a stand-in for the user's `claude` CLI, so installer tests need no real CLI or account. */

export const ok = (json: unknown = null): CliResult => ({ ok: true, status: 0, json, stdout: "", stderr: "" });

/** A CLI stand-in that edits .claude/settings.json the way `claude plugin install/uninstall` does. */
export function fakeCli(
  root: string,
  opts: { marketplaces?: string[]; version?: string } = {},
): Cli & { calls: string[] } {
  const settings = join(root, ".claude", "settings.json");
  const calls: string[] = [];
  const edit = (fn: (s: { enabledPlugins?: Record<string, boolean> }) => void) => {
    const s = existsSync(settings) ? JSON.parse(readFileSync(settings, "utf8")) : {};
    fn(s);
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify(s));
  };
  return {
    calls,
    installPlugin: (id) => {
      calls.push(`install ${id}`);
      edit((s) => {
        s.enabledPlugins = { ...s.enabledPlugins, [id]: true };
      });
      return ok({ outcome: "ok" });
    },
    uninstallPlugin: (id) => {
      calls.push(`uninstall ${id}`);
      edit((s) => {
        delete s.enabledPlugins?.[id];
      });
      return ok();
    },
    listPlugins: () => ok([{ id: "demo@mkt", version: opts.version ?? "1.0.1", scope: "project" }]),
    listMarketplaces: () => ok((opts.marketplaces ?? ["mkt"]).map((name) => ({ name }))),
    addMcp: (name, scope, command, args) => {
      calls.push(`mcp add ${scope} ${name} ${[command, ...args].join(" ")}`);
      return ok();
    },
    removeMcp: (name, scope) => {
      calls.push(`mcp remove ${scope} ${name}`);
      return ok();
    },
  };
}
