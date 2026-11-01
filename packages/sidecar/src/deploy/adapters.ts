import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DeployTarget } from "@agentchainer/protocol";
import type { RunResult } from "../run-async.ts";
import type { RunCli } from "./cli.ts";

type Env = "preview" | "production";
/** What a deploy is for: a short alias (the task's) and a message (its objective). */
export type DeployContext = { alias: string; message: string };

/**
 * A deploy provider (M6-01, design §3): how to tell a project uses it, how to ready a task's worktree for it, the
 * `whoami`-style check, the deploy and rollback commands, and how to read the deployment from the CLI's output.
 */
export type Adapter = {
  id: DeployTarget["adapter"];
  label: string;
  /** The CLI's name, as `resolveCli` finds it. */
  cli: string;
  /** The file that marks the project for this provider, and what's missing before it can deploy; null when unused. */
  detect(root: string): { config: string; problem?: string } | null;
  /** Readies `code` (a task's worktree) to deploy as the workspace's project. */
  prepare(root: string, code: string): void;
  /** Whether the CLI is signed in. Its output names the account, so only the exit code counts. */
  signedIn(run: RunCli, code: string): Promise<boolean>;
  deployArgs(env: Env, ctx: DeployContext): string[];
  /** The deployment's URL and the provider's id for it, from the deploy command's output. */
  parse(result: RunResult): { url: string; deploymentId: string } | null;
  rollbackArgs(deploymentId: string): string[];
};

const urls = (text: string) => [...text.matchAll(/https:\/\/[^\s"'<>]+/g)].map((m) => m[0].replace(/[.,)]+$/, ""));

/**
 * Vercel, through `vercel` (flags checked against Vercel CLI 65.9.0). A project is linked by `vercel link`, which
 * writes `.vercel/project.json`; that folder is usually ignored by git, so a task's worktree gets a copy, or `vercel
 * deploy --yes` there would make a new project named after the worktree's folder.
 */
export const vercel: Adapter = {
  id: "vercel",
  label: "Vercel",
  cli: "vercel",
  detect(root) {
    if (existsSync(path.join(root, ".vercel", "project.json"))) return { config: ".vercel/project.json" };
    if (existsSync(path.join(root, "vercel.json"))) {
      return {
        config: "vercel.json",
        problem: "The project isn't linked to Vercel yet: run `vercel link` in the workspace.",
      };
    }
    return null;
  },
  prepare(root, code) {
    const from = path.join(root, ".vercel", "project.json");
    const to = path.join(code, ".vercel", "project.json");
    if (code === root || !existsSync(from) || existsSync(to)) return;
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  },
  async signedIn(run, code) {
    return (await run(["whoami"], code, { timeoutMs: 30_000 })).status === 0;
  },
  deployArgs: (env) => (env === "production" ? ["deploy", "--prod", "--yes"] : ["deploy", "--yes"]),
  parse(result) {
    // The deployment's URL is what `vercel deploy` prints on stdout; progress goes to stderr.
    const url = urls(result.stdout).at(-1);
    return url ? { url, deploymentId: url } : null;
  },
  rollbackArgs: (deploymentId) => ["rollback", deploymentId, "--yes"],
};

const WRANGLER_CONFIGS = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"];

/**
 * Cloudflare Workers, through `wrangler` (flags checked against wrangler 4.58.0). A preview uploads a new version
 * without sending traffic to it (`versions upload --preview-alias`), so production keeps serving the deployed one;
 * rollback goes back to a version. A Worker must exist (deployed once) before versions can be uploaded. Pages
 * projects (`pages_build_output_dir`) come later in M6.
 */
export const cloudflare: Adapter = {
  id: "cloudflare",
  label: "Cloudflare Workers",
  cli: "wrangler",
  detect(root) {
    const config = WRANGLER_CONFIGS.find((c) => existsSync(path.join(root, c)));
    if (!config) return null;
    if (/pages_build_output_dir/.test(readFileSync(path.join(root, config), "utf8"))) {
      return {
        config,
        problem: "This is a Cloudflare Pages project; Pages deploys come later. Workers are supported.",
      };
    }
    return { config };
  },
  prepare() {
    // The config is part of the repository, so the worktree has it.
  },
  async signedIn(run, code) {
    // whoami exits 0 either way; signed out, it says so.
    const r = await run(["whoami"], code, { timeoutMs: 30_000 });
    return r.status === 0 && !/not authenticated|wrangler login/i.test(`${r.stdout}\n${r.stderr}`);
  },
  deployArgs: (env, ctx) =>
    env === "production"
      ? ["deploy"]
      : ["versions", "upload", "--preview-alias", ctx.alias, "--message", ctx.message.slice(0, 100)],
  parse(result) {
    const text = `${result.stdout}\n${result.stderr}`;
    const version = /Worker Version ID:\s*([0-9a-f-]{8,})/i.exec(text)?.[1];
    const alias = /Version Preview Alias URL:\s*(https:\/\/\S+)/i.exec(text)?.[1];
    const preview = /Version Preview URL:\s*(https:\/\/\S+)/i.exec(text)?.[1];
    const url = alias ?? preview ?? urls(result.stdout).at(-1);
    return url && version ? { url, deploymentId: version } : null;
  },
  rollbackArgs: (version) => ["rollback", version, "--message", "Rolled back from AgentChainer", "--yes"],
};

export const ADAPTERS: readonly Adapter[] = [vercel, cloudflare];
