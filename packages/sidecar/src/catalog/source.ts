import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { type Catalog, CatalogSchema, catalogProblems, ItemSchema, ProfileSchema } from "./schema.ts";

/**
 * Reads and validates the YAML catalog in `catalog/` (M2-01). Build-time only: the sidecar ships the compiled
 * `catalog.json`, so the app never parses YAML at runtime.
 */
export function readCatalogSource(dir: string): Catalog {
  const yamlFiles = (sub: string) =>
    readdirSync(path.join(dir, sub))
      .filter((f) => f.endsWith(".yaml"))
      .sort()
      .map((f) => ({ file: `${sub}/${f}`, data: parse(readFileSync(path.join(dir, sub, f), "utf8")) as unknown }));
  const header = parse(readFileSync(path.join(dir, "catalog.yaml"), "utf8")) as { version?: unknown };
  const parsed = CatalogSchema.safeParse({
    version: header.version,
    items: yamlFiles("items").map(({ data }) => data),
    profiles: yamlFiles("profiles").map(({ data }) => data),
  });
  if (!parsed.success) throw new Error(`catalog/ is invalid:\n${z.prettifyError(parsed.error)}`);
  for (const { file, data } of [...yamlFiles("items"), ...yamlFiles("profiles")]) {
    const id = (data as { id?: unknown }).id;
    if (`${id}.yaml` !== path.basename(file)) throw new Error(`${file}: the file name must be <id>.yaml`);
  }
  const problems = catalogProblems(parsed.data);
  if (problems.length) throw new Error(`catalog/ is inconsistent:\n- ${problems.join("\n- ")}`);
  return parsed.data;
}

/** The compiled catalog the sidecar imports. */
export const catalogJsonText = (catalog: Catalog) => `${JSON.stringify(catalog, null, 2)}\n`;

/** `catalog/schema.json`, for editors and reviewers. */
export const catalogSchemaText = () =>
  `${JSON.stringify(
    {
      $comment: "Generated from packages/sidecar/src/catalog/schema.ts by packages/sidecar/scripts/build-catalog.ts.",
      item: z.toJSONSchema(ItemSchema, { io: "input" }),
      profile: z.toJSONSchema(ProfileSchema, { io: "input" }),
    },
    null,
    2,
  )}\n`;
