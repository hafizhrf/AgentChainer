// Writes schema/protocol.schema.json from the zod schemas. src/schema-export.test.ts fails while it's stale.
import { mkdirSync, writeFileSync } from "node:fs";
import { schemaFileText } from "../src/schema-export.ts";

mkdirSync(new URL("../schema/", import.meta.url), { recursive: true });
writeFileSync(new URL("../schema/protocol.schema.json", import.meta.url), schemaFileText());
console.log("wrote packages/protocol/schema/protocol.schema.json");
