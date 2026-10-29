import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Item } from "../catalog/schema.ts";
import { type HookFile, hookChanges, hookScope, hookSetup } from "./git-hooks.ts";
import { binaryName, toolPath } from "./tools.ts";

/**
 * What an item's install steps will do in a workspace (M2-15): the exact file changes and CLI commands, or why it
 * can't be installed here. The plan shows this as the preview, and apply carries out the same changes, so what was
 * reviewed is what gets written.
 */
export type ItemChanges = {
  files: HookFile[];
  commands: string[][];
  /** The scope after looking at the workspace: a hook is local when there's no hook manager. */
  scope: Item["install"]["scope"];
  /** The downloaded binary's path, for items with one. */
  binary: string | null;
  unavailable?: string;
};

export function itemChanges(root: string, item: Item, env: { toolsDir: string | null; platform: string }): ItemChanges {
  const out: ItemChanges = { files: [], commands: [], scope: item.install.scope, binary: null };
  const name = binaryName(item);
  if (name) {
    if (!env.toolsDir) return { ...out, unavailable: "AgentChainer's tools folder isn't set up. Restart the app." };
    out.binary = toolPath(env.toolsDir, item, env.platform);
  }
  const argv = (args: string[]) => args.map((a) => (a === "{binary}" ? (out.binary ?? a) : a));
  for (const step of item.install.steps) {
    if ("pre-commit-hook" in step) {
      const setup = hookSetup(root);
      if (!setup.manager) return { ...out, unavailable: setup.reason };
      out.scope = hookScope(setup.manager);
      const version = item.source.type === "release-asset" ? item.source.version : "";
      try {
        out.files.push(
          ...hookChanges(root, setup.manager, step["pre-commit-hook"], {
            id: item.id,
            name: name ?? item.id,
            version,
            binary: out.binary ?? "",
          }),
        );
      } catch (err) {
        return { ...out, unavailable: err instanceof Error ? err.message : String(err) };
      }
    } else if ("mcp-add" in step) {
      const { name: server, command } = step["mcp-add"];
      out.commands.push(["claude", "mcp", "add", "--scope", item.install.scope, server, "--", ...argv(command)]);
    } else if ("merge-json" in step) {
      const rel = step["merge-json"].path;
      const file = path.join(root, ...rel.split("/"));
      const before = existsSync(file) ? readFileSync(file, "utf8") : "";
      try {
        out.files.push({ path: rel, before, after: mergeJson(before, step["merge-json"].value, rel) });
      } catch (err) {
        return { ...out, unavailable: err instanceof Error ? err.message : String(err) };
      }
    } else if ("run" in step) {
      out.commands.push(argv(step.run));
    }
  }
  return out;
}

/** `value` merged into the JSON object in `text` (objects merge key by key; anything else is replaced). */
export function mergeJson(text: string, value: Record<string, unknown>, label = "the file"): string {
  let base: unknown = {};
  if (text.trim()) {
    try {
      base = JSON.parse(text);
    } catch {
      throw new Error(`${label} isn't valid JSON, so it can't be merged into. Fix it first.`);
    }
  }
  if (!isObject(base)) throw new Error(`${label} doesn't hold a JSON object.`);
  return `${JSON.stringify(merge(base, value), null, 2)}\n`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = isObject(prev) && isObject(v) ? merge(prev, v) : v;
  }
  return out;
}
