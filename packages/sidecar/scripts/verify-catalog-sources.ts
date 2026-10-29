// Re-downloads every pinned git source in catalog/ and checks it against the catalog's sha256 (docs/CATALOG.md §4:
// hashes are computed by CI, not by hand). Runs in .github/workflows/catalog-sources.yml when catalog/ changes.
//
// Usage: node packages/sidecar/scripts/verify-catalog-sources.ts
import { fileURLToPath } from "node:url";
import { fetchGitHubTree, listFiles, treeHash } from "../src/bootstrap/git-source.ts";
import { readCatalogSource } from "../src/catalog/source.ts";

const catalog = readCatalogSource(fileURLToPath(new URL("../../../catalog/", import.meta.url)));
let failed = 0;
for (const item of catalog.items) {
  const src = item.source;
  if (src.type !== "git") continue;
  const tree = await fetchGitHubTree(src.repo, src.ref, src.path);
  try {
    const got = treeHash(tree.dir);
    const ok = got === src.sha256;
    if (!ok) failed++;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${item.id} ${src.repo}@${src.ref.slice(0, 7)}:${src.path} (${listFiles(tree.dir).length} files) ${ok ? "" : `expected ${src.sha256}, got ${got}`}`,
    );
    if (!ok && process.env.GITHUB_ACTIONS)
      console.log(`::error::${item.id}: sha256 is ${got}, the catalog says ${src.sha256}`);
  } finally {
    tree.cleanup();
  }
}
process.exit(failed ? 1 : 0);
