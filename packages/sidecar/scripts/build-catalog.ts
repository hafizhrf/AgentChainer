// Validates catalog/ and compiles it into packages/sidecar/src/catalog/catalog.json (shipped in the sidecar), plus
// catalog/schema.json, and compiles the first-party skills in skills/ into packages/sidecar/src/bootstrap/skills.json.
// Run after changing catalog items, profiles or skills; a test fails while any output is stale.
//
// Usage: node packages/sidecar/scripts/build-catalog.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  catalogJsonText,
  catalogSchemaText,
  readCatalogSource,
  readSkills,
  skillsJsonText,
} from "../src/catalog/source.ts";

const root = fileURLToPath(new URL("../../../catalog/", import.meta.url));
const catalog = readCatalogSource(root);
writeFileSync(new URL("../src/catalog/catalog.json", import.meta.url), catalogJsonText(catalog));
writeFileSync(new URL("schema.json", `file://${root}`), catalogSchemaText());
const skills = readSkills(fileURLToPath(new URL("../../../skills/", import.meta.url)));
writeFileSync(new URL("../src/bootstrap/skills.json", import.meta.url), skillsJsonText(skills));
console.log(
  `catalog ${catalog.version}: ${catalog.items.length} items, ${catalog.profiles.length} profiles; skills: ${Object.keys(skills).join(", ")}`,
);
