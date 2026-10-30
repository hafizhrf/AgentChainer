// Validates catalog/ and compiles it into packages/sidecar/src/catalog/catalog.json (shipped in the sidecar), plus
// catalog/schema.json; compiles the first-party skills in skills/ into packages/sidecar/src/bootstrap/skills.json; and
// compiles the task library (catalog/workflows/*.yaml and agents/ac-*.md) into packages/sidecar/src/tasks/library.json.
// Run after changing any of them; a test fails while any output is stale.
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
import { buildLibrary, libraryJsonText } from "../src/tasks/library.ts";
import { readLibrarySources } from "../src/tasks/library-source.ts";

const root = fileURLToPath(new URL("../../../catalog/", import.meta.url));
const catalog = readCatalogSource(root);
writeFileSync(new URL("../src/catalog/catalog.json", import.meta.url), catalogJsonText(catalog));
writeFileSync(new URL("schema.json", `file://${root}`), catalogSchemaText());
const skills = readSkills(fileURLToPath(new URL("../../../skills/", import.meta.url)));
writeFileSync(new URL("../src/bootstrap/skills.json", import.meta.url), skillsJsonText(skills));
const sources = readLibrarySources(fileURLToPath(new URL("../../../", import.meta.url)));
const library = buildLibrary(sources.workflows, sources.roles);
writeFileSync(new URL("../src/tasks/library.json", import.meta.url), libraryJsonText(library));
console.log(
  `catalog ${catalog.version}: ${catalog.items.length} items, ${catalog.profiles.length} profiles; skills: ${Object.keys(skills).join(", ")}; workflows: ${Object.keys(library.workflows).join(", ")}; roles: ${Object.keys(library.roles).length}`,
);
