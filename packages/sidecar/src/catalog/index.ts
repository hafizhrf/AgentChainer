import compiled from "./catalog.json" with { type: "json" };
import { type Catalog, CatalogSchema } from "./schema.ts";

/** The catalog snapshot shipped with this build (ADR-0007), checked once at startup. */
export const catalog: Catalog = CatalogSchema.parse(compiled);
