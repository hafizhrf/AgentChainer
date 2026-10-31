# Catalog review draft: codebase-memory-mcp 0.12.1, 2026-10-31

The re-review that [M2-32](../CHECKLIST.md) asks for, against the checklist in
[CATALOG §4](../CATALOG.md#4-review-checklist-adding-or-updating-an-item). It follows the
[2026-10-30 review](2026-10-30.md#codebase-memory-mcp-community-not-approved-at-0110), which did not approve 0.11.0.

- **Status: draft.** `codebase-memory-mcp` is a community item and needs **two** signed maintainer reviews. This
  document is evidence for them, not a review: the item's `reviews` stays empty, and the item isn't offered, until two
  maintainers sign.
- **Evidence gathered by:** Claude, read-only. The v0.12.1 source tarball, the release metadata and the strings of the
  windows-amd64 binary were read. No upstream code or binary was executed. Facts that still need a run are marked
  **(verify)**.

## Pin

- Release [v0.12.1](https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.12.1), published 2026-10-16. It's
  immutable, and older than the catalog's 14-day minimum.
- The new pin, with sha256 per asset, comes from the update bot (`check-catalog-updates.ts`). `verify-catalog-sources.ts`
  re-checks it.
- What changed since the reviewed v0.11.0 (`v0.11.0...v0.12.1`):
  - 1162 commits;
  - v0.12.0 adds the CBM Lens web UI, documentation and infrastructure in the graph, and Smart CI test selection;
  - v0.12.1 is 13 commits: package installer fixes, Helm and Docker graph passes, and CI.

## Checklist (§4)

### License: MIT. No copyleft is bundled.

- `LICENSE` is still MIT.
- `THIRD_PARTY.md` adds the following, each with a notice duty that `THIRD_PARTY_NOTICES.md` in the release archive
  covers:
  - tree-sitter grammars for JavaScript, TSX and Pascal (MIT);
  - PDF tables (Adobe BSD-3-Clause, Unicode License v3);
  - nomic-embed-code vectors (Apache-2.0);
  - zstd (BSD-3-Clause).
- `graph-ui/THIRD_PARTY.md`: three.js and react-three, transformers.js (Apache-2.0), onnxruntime-web (MIT), and
  postprocessing (Zlib).
- One model the UI can download, LFM2.5, has a Liquid AI commercial license. It is never bundled; the user downloads it
  by choice.
- The tools folder keeps the archive's license and notice files next to the binary (2026-10-30 review).

### Pinned, hashes from CI, provenance verified.

- The release carries `checksums.txt` with a Sigstore bundle (`checksums.txt.bundle`), a Sigstore `.bundle` per
  archive, and `sbom.json`.
- GitHub attestations (SLSA v1 and release) exist for all five assets the catalog uses.
- `gh attestation verify` passed on the windows-amd64 zip, and its sha256 matched.

| Platform | Asset | Size | sha256 |
|---|---|---|---|
| darwin-arm64 | `codebase-memory-mcp-darwin-arm64.tar.gz` | 49.9 MB | `9bfcbe38414b47969a3e1d1c1999f5357409387c86fa3d24221b5458267660d2` |
| darwin-x64 | `codebase-memory-mcp-darwin-amd64.tar.gz` | 50.6 MB | `ca6e64397a8ae80cec898a8205a6aa16750ac798acc05a0c3ed983837944a581` |
| linux-x64 | `codebase-memory-mcp-linux-amd64-portable.tar.gz` | 48.9 MB | `8c3d0341064301e78ecc84cf7348d4e2c6562a0f57448243ea560aaa34de36c1` |
| linux-arm64 | `codebase-memory-mcp-linux-arm64-portable.tar.gz` | 48.5 MB | `ed0f1f548cd79b121c401c2e9f7841c189a001af26d3768368088c24f6a53533` |
| win32-x64 | `codebase-memory-mcp-windows-amd64.zip` | 48.5 MB | `4e4e0f16b45233af5c757a1fcbe3c3b16e9056375b1fbe2ce020b6de75dedcc0` |

The Windows zip holds a 334 MB exe, `LICENSE`, `install.ps1` (never run by AgentChainer) and
`THIRD_PARTY_NOTICES.md`.

### Network and telemetry: the binary calls out to nothing; its local web UI is on by default.

- **No outbound requests from the binary:**
  - The only IPv4 listener is the UI, bound to 127.0.0.1 (`src/ui/httpd.c:248`). The other `connect` is a loopback
    probe (`src/main.c:2205-2208`). The daemon talks over AF_UNIX sockets (`src/daemon/ipc.c:813`).
  - The update check is gone from release builds: "deliberately NO production update-check provider"
    (`src/daemon/application.c:70-82`).
  - The curl-based `update` and download code compiles only into test builds (`#ifdef CBM_CLI_ENABLE_TEST_API`,
    `src/cli/cli.c:8082-8253`, `13468-13650`; the flag is set only for tests, `Makefile.cbm:106`). In a release
    build, `update` only prints the install command.
  - Upstream's `SECURITY.md:17-29` still describes an update check; that text is out of date.
- **Binary strings (windows-amd64):**
  - no `api.github.com`, no `releases/latest`, no WinHTTP or WinINet;
  - its Winsock imports are only accept, bind, connect, listen, send and recv, with no resolver;
  - no telemetry or crash reporting was found;
  - git is run, but never `fetch`, `pull` or `clone`.
- **The web UI (CBM Lens) is on by default, with no sign-in. 0.11.0 behaved the same, and the 2026-10-30 review missed
  it.**
  - `CBM_UI_DEFAULT_ENABLED` is false (`src/ui/config.h:14`). But when `~/.cache/codebase-memory-mcp/config.json`
    doesn't exist and the binary has the UI embedded, which release builds always do, `ui_enabled` becomes true
    (`src/ui/config.c:124-129`).
  - The daemon then serves `127.0.0.1:9749`. On the owner's Windows machine, a running `codebase-memory-mcp.exe` was
    found listening on 127.0.0.1:9749 (its version wasn't checked). Whether a first run of 0.12.1 starts it: **(verify)**
    by running it.
  - **Protections:** Host and Origin checks against DNS rebinding (`http_server.c:3172-3192`). Indexing through `/rpc`
    is refused (`:3453-3480`).
  - **No token:** any local program can call `/rpc` (the read-only tools), `/api/browse`, `/api/index` and
    `POST /api/config`.
  - `--ui=false` turns it off, but the setting is **persisted for the whole account** ("Enable/disable HTTP UI server
    (persisted)", `src/main.c:11`, `:1146`), and the daemon is shared by every agent.
  - **Decision (owner, 2026-10-31):** the item doesn't pass `--ui=false`, because AgentChainer doesn't change a setting
    shared by every agent on the account. `permissions` now says the UI is there, what it allows, and how to turn it
    off.
- **The in-browser assistant downloads model weights only when the user clicks Download:**
  - it fetches them from `huggingface.co` and `us.aws.cdn.hf.co` (`graph-ui/src/browser-ai/BrowserAiPanel.tsx:49`);
  - revisions are pinned (`model-policy.ts:1-18`), but the weights aren't re-hashed;
  - the CSP allows connections only to self, `127.0.0.1:4141` (an optional local llama server) and Hugging Face, and
    scripts only from self (`src/ui/http_server.h:26-33`);
  - the ONNX/WASM runtime is served from the binary (`browser-ai.worker.ts:93`); onnxruntime-web's jsdelivr default is
    overridden and also blocked by the CSP.

### Permissions and risk match what it does: `risk: medium` stays; `permissions` updated.

- **Background process:** a per-account daemon is required (README:141-161). It runs the watcher (`watcher_enabled`
  defaults to true) and the UI, and stops after the last session ends.
- **Where it writes:**
  - `CBM_CACHE_DIR`, by default `~/.cache/codebase-memory-mcp` (`foundation/platform.c:630-654`), including `logs/`
    and `config.json`;
  - a coordination folder outside the cache: `/tmp/cbm-daemon-<uid>` (`/private/tmp` on macOS), or `%LOCALAPPDATA%`
    on Windows. `CBM_RUNTIME_DIR` overrides it (`daemon/ipc.c:1046-1076`, `bootstrap.c:227`).
- **Index scope:** `CBM_ALLOWED_ROOT` can limit which folders it indexes. By default Claude can index any folder.
- **MCP tools:** the same 17 tools as 0.11.0. New parameters:
  - `index_repository`: `async` (the index keeps running after the call is cancelled, #2357), `status` and
    `doc_candidates`;
  - `detect_changes`: `config_path`, "absolute or project-relative" (`mcp.c:17437`), so it may read a file outside the
    project **(verify)**;
  - `get_architecture`, `search_graph` and `ingest_traces`: additions that only read.
  - `manage_adr` writes into the index database, not the repository.
- **Changes made to the item's `permissions`:**
  - the UI, what it allows, and `--ui=false`;
  - the daemon's folder and async indexing;
  - "no network requests", reworded to cover the UI's optional model download.

### Install and uninstall on macOS, Windows and Ubuntu

- Covered by the CI job "Bootstrap exit" (`exit.test.ts`) on all three OSes. It downloads the pinned asset, checks
  its hash, registers the server, and then rolls back to byte-identical files.
- The daemon's cache and runtime folders sit outside the workspace, and rollback doesn't remove them. They are listed
  in `permissions`.

### `why` is written for a non-expert: unchanged, still accurate.

### Upstream diff summarized: see the Pin section.

## Security fixes since 0.11.0

The three issues that blocked 0.11.0 are all in the v0.12.0 tag (`behind_by=0`):

- #2445, a heap overflow reachable through `query_graph`, merged 2026-10-01;
- #2489, a symlink escape, merged 2026-10-04;
- #2491, a symlink escape, merged 2026-10-07.

The v0.12.0 notes also list hardening in #2490, #2479, #2475, #2474, #2256, #2473 and #2510: resource limits, link
handling, and closing inherited descriptors. v0.12.1 has no security fixes.

## Outcome proposed to the reviewers

**Approve at 0.12.1**, with the permission changes above. No hard blocker was found.

Before signing, a reviewer should run the binary once and confirm:
1. whether the UI starts on 127.0.0.1:9749 on a fresh account;
2. what `detect_changes` does with an absolute `config_path`.

To sign, add a `reviews` entry (`by`, `date`, `ref: v0.12.1`, `notes`) in `catalog/items/codebase-memory-mcp.yaml`.
The item needs two.

## Correction to the 2026-10-30 review

That review said "Network: none in the 0.11.0 build". That is still true for outbound requests. It missed that
0.11.0 also serves the unauthenticated loopback UI by default (the same `config.c` code).
