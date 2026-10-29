// Re-downloads every pinned source in catalog/ and checks it against the catalog (docs/CATALOG.md §4: hashes are
// computed by CI, not by hand). Runs in .github/workflows/catalog-sources.yml when catalog/ changes.
// - git: the tree hash of the folder at the pinned commit;
// - release assets (M2-15): each platform's download, hashed here and compared with GitHub's own sha256 digest;
// - npm: the registry's integrity for the pinned version.
//
// Usage: node packages/sidecar/scripts/verify-catalog-sources.ts
import { createHash } from "node:crypto";
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
const report = (ok: boolean, id: string, what: string, problem: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${id} ${what}${ok ? "" : ` ${problem}`}`);
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error::${id}: ${what} ${problem}`);
};
const githubHeaders: Record<string, string> = process.env.GITHUB_TOKEN
  ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
  : {};

for (const item of catalog.items) {
  const src = item.source;
  if (src.type === "release-asset") {
    // GitHub publishes a sha256 digest per release asset; it must agree with the catalog and with the download.
    const repo = new URL(src.repo).pathname.replace(/^\/|\.git$/g, "");
    const digests = new Map<string, string>();
    for (const tag of [`v${src.version}`, src.version]) {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers: githubHeaders });
      if (!res.ok) continue;
      const release = (await res.json()) as { assets: { browser_download_url: string; digest?: string }[] };
      for (const a of release.assets)
        if (a.digest) digests.set(a.browser_download_url, a.digest.replace(/^sha256:/, ""));
      break;
    }
    for (const [platform, asset] of Object.entries(src.assets)) {
      const res = await fetch(asset.url);
      const got = res.ok
        ? createHash("sha256")
            .update(new Uint8Array(await res.arrayBuffer()))
            .digest("hex")
        : `HTTP ${res.status}`;
      const github = digests.get(asset.url);
      const ok = got === asset.sha256 && (github === undefined || github === asset.sha256);
      report(
        ok,
        item.id,
        `${src.version} ${platform}`,
        `catalog ${asset.sha256}, download ${got}, GitHub ${github ?? "no digest"}`,
      );
    }
  } else if (src.type === "npm") {
    const res = await fetch(`https://registry.npmjs.org/${src.name.replace("/", "%2F")}/${src.version}`);
    const got = res.ok
      ? ((await res.json()) as { dist?: { integrity?: string } }).dist?.integrity
      : `HTTP ${res.status}`;
    report(got === src.integrity, item.id, `${src.name}@${src.version}`, `catalog ${src.integrity}, registry ${got}`);
  }
}
process.exit(failed ? 1 : 0);
