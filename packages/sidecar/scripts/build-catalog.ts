// Validates catalog/ and compiles it into packages/sidecar/src/catalog/catalog.json (shipped in the sidecar), plus
// catalog/schema.json. Run after changing catalog items or profiles; a test fails while either output is stale.
//
// Usage: node packages/sidecar/scripts/build-catalog.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { catalogJsonText, catalogSchemaText, readCatalogSource } from "../src/catalog/source.ts";

const root = fileURLToPath(new URL("../../../catalog/", import.meta.url));
const catalog = readCatalogSource(root);
writeFileSync(new URL("../src/catalog/catalog.json", import.meta.url), catalogJsonText(catalog));
writeFileSync(new URL("schema.json", `file://${root}`), catalogSchemaText());
console.log(`catalog ${catalog.version}: ${catalog.items.length} items, ${catalog.profiles.length} profiles`);
