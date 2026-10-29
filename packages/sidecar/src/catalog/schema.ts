import { z } from "zod";

/**
 * The essentials catalog (M2-01, docs/CATALOG.md §3): items and profiles as YAML in `catalog/`, validated against
 * these schemas in CI and compiled into `catalog.json`, which ships inside the sidecar (ADR-0007). Every source is
 * pinned (ADR-0005): commit SHAs, release assets or npm versions with hashes; marketplace plugins can't be pinned by
 * the CLI, so the reviewed version and marketplace commit are recorded instead (spike S6).
 */

const Sha1 = z.string().regex(/^[0-9a-f]{40}$/, "a full 40-character commit SHA, never a branch or tag");
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "a hex sha256");

export const TIERS = ["first-party", "official", "verified-vendor", "community"] as const;
export const TierSchema = z.enum(TIERS);

/** Reviews an item needs before the plan offers it (ADR-0005; docs/CATALOG.md §2). */
export const REQUIRED_REVIEWS: Record<(typeof TIERS)[number], number> = {
  "first-party": 0,
  official: 1,
  "verified-vendor": 1,
  community: 2,
};

const SourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("marketplace"),
    marketplace: z.string(),
    repo: z.string(),
    plugin: z.string(),
    reviewedVersion: z.string().optional(),
    reviewedRef: Sha1,
  }),
  z.object({ type: z.literal("git"), repo: z.url(), ref: Sha1, path: z.string(), sha256: Sha256 }),
  z.object({
    type: z.literal("release-asset"),
    repo: z.url(),
    version: z.string(),
    /** Per platform; a platform without an asset makes the item unavailable there. */
    assets: z.partialRecord(
      z.enum(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]),
      z.object({ url: z.url(), sha256: Sha256 }),
    ),
  }),
  z.object({
    type: z.literal("npm"),
    name: z.string(),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/, "an exact version"),
    integrity: z.string().startsWith("sha512-"),
  }),
  z.object({ type: z.literal("first-party"), path: z.string() }),
]);

/**
 * Declarative steps only: no shell strings, so nothing can expand or pipe (docs/CATALOG.md §3). In an argv, `{binary}`
 * is the item's downloaded binary; where it lives is the app's choice, never the item's.
 */
const StepSchema = z.union([
  z.object({ copy: z.object({ from: z.string(), to: z.string() }) }).strict(),
  z.object({ remove: z.string() }).strict(),
  z.object({ run: z.array(z.string()).min(1) }).strict(),
  /** Fetches the release asset for this platform, checks its sha256, and keeps `binary` from it (M2-15). */
  z.object({ "download-binary": z.object({ binary: z.string().regex(/^[\w.-]+$/) }).strict() }).strict(),
  /** Registers a stdio MCP server with `claude mcp add --scope <install scope>`. */
  z
    .object({
      "mcp-add": z.object({ name: z.string().regex(/^[\w-]+$/), command: z.array(z.string()).min(1) }).strict(),
    })
    .strict(),
  /** Runs `run` before each commit, through the repo's hook manager or a local git hook (M2-22). */
  z
    .object({
      "pre-commit-hook": z.object({ id: z.string().regex(/^[a-z0-9-]+$/), run: z.array(z.string()).min(1) }).strict(),
    })
    .strict(),
  z.object({ "merge-json": z.object({ path: z.string(), value: z.record(z.string(), z.unknown()) }) }).strict(),
  z.object({ "write-file": z.object({ path: z.string(), content: z.string() }) }).strict(),
]);
export type Step = z.infer<typeof StepSchema>;

export const ItemSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string(),
    kind: z.enum(["skill", "plugin", "mcp", "hook", "agent", "tool"]),
    tier: TierSchema,
    license: z.string(),
    homepage: z.url().optional(),
    summary: z.string(),
    /** Shown to users, in plain language. */
    why: z.string(),
    source: SourceSchema,
    platforms: z.array(z.enum(["darwin", "linux", "win32"])).min(1),
    /** Commands that must be on PATH, with how to get them. */
    requires: z.array(z.object({ tool: z.string(), hint: z.string() })).default([]),
    risk: z.enum(["low", "medium", "high"]),
    permissions: z.array(z.string()),
    /** Env var names the item reads; values are never written to files. */
    secrets: z.array(z.string()).default([]),
    install: z.object({ scope: z.enum(["project", "user", "local"]), steps: z.array(StepSchema).min(1) }),
    /**
     * What removing the item takes, for reviewers. Rollback itself restores files from backups and undoes the CLI
     * registrations it made, so items that only write files or download a tool can leave this out.
     */
    uninstall: z.object({ steps: z.array(StepSchema).min(1) }).optional(),
    /** Maintainer reviews against docs/CATALOG.md §4; the item is offered once its tier's count is met. */
    reviews: z
      .array(z.object({ by: z.string(), date: z.iso.date(), ref: z.string(), notes: z.string().optional() }))
      .default([]),
    notes: z.string().optional(),
  })
  .strict();
export type Item = z.infer<typeof ItemSchema>;

export const ProfileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string(),
    description: z.string(),
    /** When the plan suggests the profile: always, for detected stacks, a git host, or only on request. */
    suggest: z.union([
      z.object({ always: z.literal(true) }).strict(),
      z.object({ stacks: z.array(z.string()).min(1) }).strict(),
      z.object({ remoteHost: z.string() }).strict(),
      z.object({ optIn: z.literal(true) }).strict(),
    ]),
    items: z.array(z.string()).min(1),
  })
  .strict();
export type Profile = z.infer<typeof ProfileSchema>;

export const CatalogSchema = z.object({
  /** Date-based, e.g. 2026.10.29: bumped whenever items or profiles change. */
  version: z.string().regex(/^\d{4}\.\d{1,2}\.\d{1,2}$/),
  items: z.array(ItemSchema),
  profiles: z.array(ProfileSchema),
});
export type Catalog = z.infer<typeof CatalogSchema>;

/** Cross-references the schemas can't express. Returns problems; an empty list means valid. */
export function catalogProblems(catalog: Catalog): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const item of catalog.items) {
    if (ids.has(item.id)) problems.push(`duplicate item id ${item.id}`);
    ids.add(item.id);
    if (item.tier === "first-party" && item.source.type !== "first-party") {
      problems.push(`${item.id}: first-party items come from this repo`);
    }
    if (item.source.type === "first-party" && item.tier !== "first-party") {
      problems.push(`${item.id}: only first-party items may use a first-party source`);
    }
    if (item.kind === "plugin" && item.source.type !== "marketplace") {
      problems.push(`${item.id}: plugins install through a marketplace`);
    }
    problems.push(...stepProblems(item));
  }
  for (const profile of catalog.profiles) {
    for (const ref of profile.items) if (!ids.has(ref)) problems.push(`profile ${profile.id}: unknown item ${ref}`);
  }
  return problems;
}

/** Rules for install steps: binaries only from release assets, private registration for local paths, pins and secrets. */
function stepProblems(item: Item): string[] {
  const problems: string[] = [];
  const steps = item.install.steps;
  const src = item.source;
  const argvs = steps.flatMap((s) =>
    "run" in s
      ? [s.run]
      : "mcp-add" in s
        ? [s["mcp-add"].command]
        : "pre-commit-hook" in s
          ? [s["pre-commit-hook"].run]
          : [],
  );
  const downloads = steps.filter((s) => "download-binary" in s).length;
  if (src.type === "release-asset" && downloads !== 1) {
    problems.push(`${item.id}: a release-asset item needs exactly one download-binary step`);
  }
  if (src.type !== "release-asset" && downloads) {
    problems.push(`${item.id}: download-binary needs a release-asset source`);
  }
  const usesBinary = argvs.some((argv) => argv.includes("{binary}"));
  if (usesBinary && src.type !== "release-asset") problems.push(`${item.id}: {binary} needs a release-asset source`);
  for (const s of steps) {
    // The binary's path is machine-specific, so a server that runs it is registered privately.
    if ("mcp-add" in s && s["mcp-add"].command.includes("{binary}") && item.install.scope !== "local") {
      problems.push(`${item.id}: an MCP server that runs a downloaded binary must use local scope`);
    }
  }
  if (src.type === "npm") {
    const text = JSON.stringify(steps);
    const refs = [...text.matchAll(new RegExp(`${escapeRegExp(src.name)}@([\\w.-]+)`, "g"))].map((m) => m[1]);
    if (refs.some((v) => v !== src.version)) {
      problems.push(`${item.id}: steps must run ${src.name}@${src.version}, the pinned version`);
    }
  }
  // Secrets are referenced, never written: any `${VAR}` must be one of the item's declared secrets.
  for (const m of JSON.stringify(steps).matchAll(/\$\{(\w+)\}/g)) {
    if (!item.secrets.includes(m[1] ?? "")) problems.push(`${item.id}: \${${m[1]}} isn't one of its declared secrets`);
  }
  return problems;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
