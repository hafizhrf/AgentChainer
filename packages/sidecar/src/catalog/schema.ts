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
    assets: z.record(
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

/** Declarative steps only: no shell strings, so nothing can expand or pipe (docs/CATALOG.md §3). */
const StepSchema = z.union([
  z.object({ copy: z.object({ from: z.string(), to: z.string() }) }).strict(),
  z.object({ remove: z.string() }).strict(),
  z.object({ run: z.array(z.string()).min(1) }).strict(),
  z.object({ "download-binary": z.object({ to: z.string() }) }).strict(),
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
    uninstall: z.object({ steps: z.array(StepSchema).min(1) }),
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
  }
  for (const profile of catalog.profiles) {
    for (const ref of profile.items) if (!ids.has(ref)) problems.push(`profile ${profile.id}: unknown item ${ref}`);
  }
  return problems;
}
