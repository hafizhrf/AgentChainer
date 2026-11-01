import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DeployTarget } from "@agentchainer/protocol";
import type { RunResult } from "../run-async.ts";
import type { RunCli } from "./cli.ts";

export type Env = "preview" | "production";
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
  /** The environments it can deploy to: Fly.io has no previews. */
  environments: readonly Env[];
  /** The file that marks the project for this provider, and what's missing before it can deploy; null when unused. */
  detect(root: string): { config: string; problem?: string } | null;
  /** The provider's project name, from its config (the name a person types to confirm production); null if unknown. */
  projectName(root: string): string | null;
  /** Readies `code` (a task's worktree) to deploy as the workspace's project. */
  prepare(root: string, code: string): void;
  /** Whether the CLI is signed in. Its output names the account, so only the exit code counts. */
  signedIn(run: RunCli, code: string): Promise<boolean>;
  deployArgs(env: Env, ctx: DeployContext): string[];
  /** The deployment's URL and the provider's id for it (what rollback goes back to), from the deploy's output. */
  parse(result: RunResult): { url: string; deploymentId?: string } | null;
  /**
   * Rolls production back to `deploymentId`, or to the provider's own previous one without it; null when the provider
   * needs the id (Fly.io and Firebase have no "previous" of their own).
   */
  rollbackArgs(deploymentId?: string): string[] | null;
};

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    // JSONC: drop line comments that start a line (wrangler.jsonc); URLs inside strings are untouched.
    return JSON.parse(readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** The JSON object a CLI printed with `--json`, ignoring anything around it. */
const jsonOf = (text: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
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
  environments: ["preview", "production"],
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
  projectName(root) {
    const name = readJson(path.join(root, ".vercel", "project.json"))?.projectName;
    return typeof name === "string" && name ? name : null;
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
  rollbackArgs: (deploymentId) => ["rollback", ...(deploymentId ? [deploymentId] : []), "--yes"],
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
  environments: ["preview", "production"],
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
  projectName(root) {
    const config = WRANGLER_CONFIGS.find((c) => existsSync(path.join(root, c)));
    if (!config) return null;
    const file = path.join(root, config);
    const name = config.endsWith(".toml")
      ? /^\s*name\s*=\s*["']([^"']+)["']/m.exec(readFileSync(file, "utf8"))?.[1]
      : readJson(file)?.name;
    return typeof name === "string" && name ? name : null;
  },
  prepare() {
    // The config is part of the repository, so the worktree has it.
  },
  async signedIn(run, code) {
    // whoami exits 0 either way; signed out, it says so.
    const r = await run(["whoami"], code, { timeoutMs: 30_000 });
    return r.status === 0 && !/not authenticated|wrangler login/i.test(`${r.stdout}\n${r.stderr}`);
  },
  // Production deploys the workspace as it is (`wrangler deploy` prints the URL and the "Current Version ID").
  deployArgs: (env, ctx) =>
    env === "production"
      ? ["deploy"]
      : ["versions", "upload", "--preview-alias", ctx.alias, "--message", ctx.message.slice(0, 100)],
  parse(result) {
    const text = `${result.stdout}\n${result.stderr}`;
    const version = /(?:Worker|Current) Version ID:\s*([0-9a-f-]{8,})/i.exec(text)?.[1];
    const alias = /Version Preview Alias URL:\s*(https:\/\/\S+)/i.exec(text)?.[1];
    const preview = /Version Preview URL:\s*(https:\/\/\S+)/i.exec(text)?.[1];
    const url = alias ?? preview ?? urls(result.stdout).at(-1);
    return url && version ? { url, deploymentId: version } : null;
  },
  rollbackArgs: (version) => [
    "rollback",
    ...(version ? [version] : []),
    "--message",
    "Rolled back from AgentChainer",
    "--yes",
  ],
};

/** `.firebaserc`'s default project. */
const firebaseProject = (root: string): string | null => {
  const projects = readJson(path.join(root, ".firebaserc"))?.projects as Record<string, unknown> | undefined;
  return typeof projects?.default === "string" && projects.default ? projects.default : null;
};

/**
 * Firebase Hosting, through `firebase` (checked against firebase-tools 15.34.2's help and source). A preview is a
 * Hosting channel (`hosting:channel:deploy <id>`, expiring after 7 days); production is `deploy --only hosting`. Both
 * print JSON with `--json`: a channel's `url` and `version`, and the live release's `sites/<site>/versions/<id>`.
 * Rollback clones the previous version back to the live channel (`hosting:clone <site>@<version> <site>:live`), so it
 * needs the version the app recorded. One Hosting site per project for now.
 */
export const firebase: Adapter = {
  id: "firebase",
  label: "Firebase Hosting",
  cli: "firebase",
  environments: ["preview", "production"],
  detect(root) {
    const config = readJson(path.join(root, "firebase.json"));
    if (!config || !("hosting" in config)) return null;
    if (Array.isArray(config.hosting) && config.hosting.length > 1) {
      return {
        config: "firebase.json",
        problem: "This project has several Hosting sites; one site is supported for now.",
      };
    }
    if (!firebaseProject(root)) {
      return {
        config: "firebase.json",
        problem: "The project has no default Firebase project: run `firebase use --add` in the workspace.",
      };
    }
    return { config: "firebase.json" };
  },
  projectName: firebaseProject,
  prepare(root, code) {
    // `.firebaserc` is usually committed; when it's ignored, the worktree gets the workspace's.
    const from = path.join(root, ".firebaserc");
    const to = path.join(code, ".firebaserc");
    if (code !== root && existsSync(from) && !existsSync(to)) copyFileSync(from, to);
  },
  async signedIn(run, code) {
    // login:list exits 0 either way; signed out, it says so.
    const r = await run(["login:list"], code, { timeoutMs: 30_000 });
    return r.status === 0 && !/no authorized accounts/i.test(`${r.stdout}\n${r.stderr}`);
  },
  deployArgs: (env, ctx) =>
    env === "production"
      ? ["deploy", "--only", "hosting", "--message", ctx.message.slice(0, 100), "--non-interactive", "--json"]
      : ["hosting:channel:deploy", ctx.alias, "--expires", "7d", "--non-interactive", "--json"],
  parse(result) {
    const out = jsonOf(result.stdout)?.result as Record<string, unknown> | undefined;
    if (!out) return null;
    // Production: the live release's version name.
    if (typeof out.hosting === "string") {
      const m = /sites\/([^/]+)\/versions\/([^/]+)$/.exec(out.hosting);
      return m ? { url: `https://${m[1]}.web.app`, deploymentId: `${m[1]}@${m[2]}` } : null;
    }
    // A channel: one entry per site.
    const site = Object.values(out).find(
      (v): v is { site?: string; url: string; version?: string } =>
        typeof v === "object" && v !== null && typeof (v as { url?: unknown }).url === "string",
    );
    if (!site?.url) return null;
    return { url: site.url, ...(site.site && site.version ? { deploymentId: `${site.site}@${site.version}` } : {}) };
  },
  rollbackArgs: (version) =>
    version ? ["hosting:clone", version, `${version.split("@")[0]}:live`, "--non-interactive"] : null,
};

/** fly.toml's `app`. */
const flyApp = (root: string): string | null => {
  const file = path.join(root, "fly.toml");
  if (!existsSync(file)) return null;
  return /^\s*app\s*=\s*["']([^"']+)["']/m.exec(readFileSync(file, "utf8"))?.[1] ?? null;
};

/**
 * Fly.io, through `fly` (flags from fly.io's flyctl reference, **not checked against an installed flyctl**). Fly has
 * no previews, so it deploys to production only: `fly deploy --remote-only --yes` builds on Fly's builder, not the
 * local Docker. The image it deployed (`registry.fly.io/<app>:deployment-…`) is what rollback redeploys with
 * `fly deploy --image`, so rollback needs the one the app recorded.
 */
export const fly: Adapter = {
  id: "fly",
  label: "Fly.io",
  cli: "fly",
  environments: ["production"],
  detect(root) {
    if (!existsSync(path.join(root, "fly.toml"))) return null;
    if (!flyApp(root)) {
      return { config: "fly.toml", problem: "fly.toml has no `app` name: run `fly launch` or set `app` in fly.toml." };
    }
    return { config: "fly.toml" };
  },
  projectName: flyApp,
  prepare() {
    // fly.toml is part of the repository.
  },
  async signedIn(run, code) {
    return (await run(["auth", "whoami"], code, { timeoutMs: 30_000 })).status === 0;
  },
  deployArgs: () => ["deploy", "--remote-only", "--yes"],
  parse(result) {
    const text = `${result.stdout}\n${result.stderr}`;
    const url = urls(text).find((u) => /\.fly\.dev\b/.test(u));
    const image = /\b(registry\.fly\.io\/[^\s"']+)/.exec(text)?.[1];
    return url ? { url: url.replace(/\/$/, ""), ...(image ? { deploymentId: image } : {}) } : null;
  },
  rollbackArgs: (image) => (image ? ["deploy", "--image", image, "--remote-only", "--yes"] : null),
};

export const ADAPTERS: readonly Adapter[] = [vercel, cloudflare, firebase, fly];
