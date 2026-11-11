import { catalog, currentLanguage, type KeyOf, type Language, type Params, setLanguage } from "@agentchainer/protocol";
import { z } from "zod";
import agents from "./locales/en/agents.json" with { type: "json" };
import bootstrap from "./locales/en/bootstrap.json" with { type: "json" };
import deploy from "./locales/en/deploy.json" with { type: "json" };
import detect from "./locales/en/detect.json" with { type: "json" };
import git from "./locales/en/git.json" with { type: "json" };
import mcp from "./locales/en/mcp.json" with { type: "json" };
import plugins from "./locales/en/plugins.json" with { type: "json" };
import rpc from "./locales/en/rpc.json" with { type: "json" };
import tasks from "./locales/en/tasks.json" with { type: "json" };
import agentsId from "./locales/id/agents.json" with { type: "json" };
import bootstrapId from "./locales/id/bootstrap.json" with { type: "json" };
import deployId from "./locales/id/deploy.json" with { type: "json" };
import detectId from "./locales/id/detect.json" with { type: "json" };
import gitId from "./locales/id/git.json" with { type: "json" };
import mcpId from "./locales/id/mcp.json" with { type: "json" };
import pluginsId from "./locales/id/plugins.json" with { type: "json" };
import rpcId from "./locales/id/rpc.json" with { type: "json" };
import tasksId from "./locales/id/tasks.json" with { type: "json" };

/**
 * The sidecar's text that reaches a person (X-13, ADR-0011): errors, setup findings, plan reasons, apply and rollback
 * messages, deploy, plugin and MCP server messages. One file per area in `locales/<language>/`, keys prefixed with the area. Both
 * languages are bundled, so `setLanguage` in `main.ts` applies at once. Text Claude reads (prompts, guard reasons) and
 * text written into a repository stay English and out of these catalogs.
 */
export const CATALOGS = { rpc, detect, bootstrap, git, deploy, plugins, mcp, tasks, agents };
export const INDONESIAN = {
  rpc: rpcId,
  detect: detectId,
  bootstrap: bootstrapId,
  git: gitId,
  deploy: deployId,
  plugins: pluginsId,
  mcp: mcpId,
  tasks: tasksId,
  agents: agentsId,
};

const english = Object.assign({}, ...Object.values(CATALOGS)) as typeof rpc &
  typeof detect &
  typeof bootstrap &
  typeof git &
  typeof deploy &
  typeof plugins &
  typeof mcp &
  typeof tasks &
  typeof agents;
const sidecar = catalog(english, { id: () => Object.assign({}, ...Object.values(INDONESIAN)) });

export type MessageKey = KeyOf<typeof english>;

/** The message for `key` in the app's language, with `params` filled in. A `count` picks the plural form. */
export const t = (key: MessageKey, params?: Params) => sidecar.t(key, params);

/**
 * Switches the process's language (X-13): every catalog, and zod's own messages. The catalogs are bundled, so it
 * applies at once.
 */
export function useLanguage(language: Language): void {
  void setLanguage(language);
  z.config(language === "id" ? z.locales.id() : z.locales.en());
}

/**
 * Runs `fn` with every message in English, for a synchronous check whose words go to Claude (X-15), then switches
 * back. Nothing else runs in between: the switch, `fn` and the switch back happen in one turn of the event loop.
 */
export function inEnglishNow<T>(fn: () => T): T {
  const was = currentLanguage();
  if (was === "en") return fn();
  useLanguage("en");
  try {
    return fn();
  } finally {
    useLanguage(was);
  }
}
