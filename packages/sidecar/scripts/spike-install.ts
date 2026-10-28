// Spike S6: install and remove a plugin and MCP servers non-interactively through the user's own CLI,
// inside a throwaway project folder, and check what each step wrote. Everything it installs is removed again.
//
// Usage: node scripts/spike-install.ts --cwd <empty scratch dir> [--plugin code-review@claude-plugins-official]
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { findClaude } from "../src/claude.ts";
import * as cli from "../src/installer.ts";

const { values } = parseArgs({
  options: { cwd: { type: "string" }, plugin: { type: "string", default: "code-review@claude-plugins-official" } },
});
if (!values.cwd) {
  console.error("--cwd is required");
  process.exit(2);
}
const claude = findClaude();
if (!claude) {
  // Report what discovery saw, so a CI failure (e.g. npm's Windows shims) is diagnosable from the annotation alone.
  const hint = `PATH has ${(process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").length} entries; platform ${process.platform}`;
  console.log(`::error title=S6 claude not found::findClaude() returned null (${hint})`);
  process.exit(2);
}
const project = join(values.cwd, `s6-project-${Date.now()}`);
mkdirSync(project, { recursive: true });
const plugin = values.plugin;

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name} — ${detail}`);
  // In GitHub Actions, surface failures as annotations, which are readable without access to the job logs.
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=S6 ${name}::${detail.replace(/\r?\n/g, " ")}`);
}
function timed<T>(fn: () => T): [T, string] {
  const t0 = performance.now();
  const value = fn();
  return [value, `${(performance.now() - t0).toFixed(0)} ms`];
}
const readJson = (path: string) =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : null;
const brief = (r: cli.CliResult) => JSON.stringify(r.json ?? (r.stdout.trim() || r.stderr.trim()).slice(0, 160));

console.log(`project: ${project}\nplugin: ${plugin}\n`);

// 1. The marketplace must already be known; we don't add marketplaces implicitly.
const marketplace = plugin.split("@")[1] ?? "";
const [mk] = timed(() => cli.listMarketplaces(claude, project));
const known = Array.isArray(mk.json) && mk.json.some((m) => (m as { name?: string }).name === marketplace);
check("marketplace is configured", mk.ok && known, `${marketplace} known=${known}`);

// 2. Install at project scope, non-interactively.
const settingsPath = join(project, ".claude", "settings.json");
const [inst, instTime] = timed(() => cli.installPlugin(claude, plugin, "project", project));
const enabledAfterInstall = (readJson(settingsPath)?.enabledPlugins as Record<string, unknown> | undefined)?.[plugin];
check(
  "plugin install (project scope, no TTY, no -y)",
  inst.ok && enabledAfterInstall === true,
  `exit=${inst.status} ${instTime} result=${brief(inst)} enabledPlugins[${plugin}]=${enabledAfterInstall}`,
);

// 3. What version did we get? (There is no flag to pin one; the lockfile must record it.)
const [list] = timed(() => cli.listPlugins(claude, project));
const pluginName = plugin.split("@")[0] ?? plugin;
const entry = Array.isArray(list.json) ? list.json.find((p) => JSON.stringify(p).includes(pluginName)) : undefined;
check(
  "installed plugin is listed with a version",
  list.ok && entry !== undefined,
  `entry=${JSON.stringify(entry)?.slice(0, 300)}`,
);

// 4. Uninstall again.
const [uninst, uninstTime] = timed(() => cli.uninstallPlugin(claude, plugin, "project", project));
const enabledAfterUninstall = (readJson(settingsPath)?.enabledPlugins as Record<string, unknown> | undefined)?.[plugin];
check(
  "plugin uninstall (project scope)",
  uninst.ok && enabledAfterUninstall !== true,
  `exit=${uninst.status} ${uninstTime} result=${brief(uninst)} enabled after=${enabledAfterUninstall}`,
);

// 5. MCP, local scope: private to this user and project (stored in the user's ~/.claude.json under this project).
const server = "agentchainer-s6-probe";
const [addLocal] = timed(() =>
  cli.addMcpServer(claude, server, "local", "node", ["-e", "process.stdin.resume()"], project),
);
const getLocal = cli.getMcpServer(claude, server, project);
const removeLocal = cli.removeMcpServer(claude, server, "local", project);
const goneLocal = !cli.getMcpServer(claude, server, project).ok;
check(
  "MCP add/get/remove (local scope)",
  addLocal.ok && getLocal.ok && removeLocal.ok && goneLocal,
  `add=${addLocal.status} get=${getLocal.status} remove=${removeLocal.status} gone=${goneLocal}`,
);

// 6. MCP, project scope: writes the shareable .mcp.json in the project.
const mcpJson = join(project, ".mcp.json");
const addProject = cli.addMcpServer(claude, server, "project", "node", ["-e", "process.stdin.resume()"], project);
const inFile = Boolean((readJson(mcpJson)?.mcpServers as Record<string, unknown> | undefined)?.[server]);
const removeProject = cli.removeMcpServer(claude, server, "project", project);
const stillInFile = Boolean((readJson(mcpJson)?.mcpServers as Record<string, unknown> | undefined)?.[server]);
check(
  "MCP add/remove (project scope → .mcp.json)",
  addProject.ok && inFile && removeProject.ok && !stillInFile,
  `add=${addProject.status} written=${inFile} remove=${removeProject.status} still there=${stillInFile}`,
);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
