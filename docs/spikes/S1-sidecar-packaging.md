# Spike S1 — Sidecar packaging and first-run SDK download

- **Date:** 2026-10-28
- **Checklist:** M0-15 (S1), M0-21 (ADR-0003)
- **Status:**
  - macOS (x86_64): complete, end to end.
  - Windows and Ubuntu: the packaged-sidecar smoke runs in CI on every PR. Launching the full app with a signed-in CLI
    is still open (see "Not covered yet").

## Question

Can the sidecar ship as one executable that needs no Node.js on the user's machine? It must contain only our code,
because the Agent SDK can't be redistributed (M0-03), so the SDK has to be fetched, verified and loaded at runtime.
And does the packaged app still find the user's `claude` when launched from Finder, where PATH is minimal?

## What was built

| Piece | What it does |
|---|---|
| `packages/sidecar/scripts/build-sea.ts` | Runs four steps; skips all work when the output is newer than every input (~10 s otherwise). |
| `packages/sidecar/src/sdk-pin.json` + `scripts/pin-sdk.ts` | Exact SDK version, npm tarball URL and sha512 integrity, generated from `pnpm-lock.yaml`. A unit test fails if the pin drifts from the lockfile. |
| `packages/sidecar/src/sdk-loader.ts` | Dev: `import("@anthropic-ai/claude-agent-sdk")` from node_modules. Packaged (`AGENTCHAINER_DATA_DIR` set): see the steps below. A failure is reported and retried on the next `session.start`. |
| `sdk.prepare` RPC | Makes the SDK ready without starting a session. Reports `node_modules`, `download` or `cache`. |
| Rust `sidecar.rs` | Release builds run the bundled sidecar next to the app binary, with `AGENTCHAINER_DATA_DIR` and `NODE_USE_ENV_PROXY=1`. Debug builds keep `node src/main.ts`. `AGENTCHAINER_SIDECAR_BIN` overrides either. |
| `tauri.conf.json` | `bundle.externalBin: ["binaries/agentchainer-sidecar"]`. `beforeDevCommand` and `beforeBuildCommand` build the sidecar first. |
| `scripts/sidecar-smoke.mjs` | Starts the packaged sidecar with an empty data dir. Checks `system.hello`, then `sdk.prepare` = `download`, then `cache` on a second start. Runs in CI on all 3 OS. |

`build-sea.ts` steps:
1. esbuild bundles our code into one CommonJS file, with the SDK left external.
2. It creates a Node SEA blob with the same Node binary it will inject into.
3. It copies that Node binary. On macOS it is thinned to the host architecture first.
4. postject injects the blob, and the result is ad-hoc signed on macOS.

The packaged loader (`sdk-loader.ts`, when `AGENTCHAINER_DATA_DIR` is set):
1. Downloads the pinned tarball into `<data>/sdk/<version>`.
2. Rejects it unless the sha512 matches.
3. Extracts it with the system `tar` into a temp dir, then renames, so a crash never leaves a half-written SDK.
4. `import()`s `sdk.mjs`.

## Results (macOS 26.5, x86_64, Node 24.18.0)

| Measurement | Result |
|---|---|
| Can a Node SEA `import()` an ESM file from disk? | **Yes.** `sdk.mjs` loads and exports `query`. Tested first with a minimal SEA, then the real sidecar |
| Does the SDK need more than one package at runtime? | **No.** `sdk.mjs` imports only Node built-ins. The peer deps (`zod`, `@modelcontextprotocol/sdk`) are used only by the `./core` entry we don't load |
| Bundled sidecar code | tens of KB (`dist/sidecar.cjs`) |
| Sidecar executable | **117 MB**, almost all of it Node itself |
| Release `AgentChainer.app` | **122 MB**: app binary 4.3 MB + sidecar 117 MB |
| Sidecar build | ~10 s (first build); no-op when up to date. Release app build: 4 min 10 s |
| Cold start to `system.hello` | First run of a freshly built binary: 0.8–3.2 s (macOS scans new executables once). After that: **125–160 ms** |
| First-run SDK download + verify + extract | **~1.4–1.5 s** for the 0.3.311 tarball (4.7 MB unpacked); `sdk.prepare` → `download` |
| Later starts | `sdk.prepare` → `cache` in ~140–340 ms after hello |
| Real session through the packaged sidecar + downloaded SDK | spike harness `--sidecar … --data-dir …`: **3/3** (streaming text, approve → allow, approve → deny) |
| **Release app launched like Finder** (`open -n --env …`; PATH `/usr/bin:/bin…`, no Node, empty data dir) | SDK downloaded and verified into `~/Library/Application Support/io.github.hafizhrf.agentchainer/sdk/0.3.311`. `claude` found at `~/.local/bin/claude` by the known-locations fallback. Self-test turn **success** ($0.0018). 11.8 s from launch to automatic quit |
| Unit tests | Download → verify → extract → cache; tampered tarball rejected; offline and HTTP errors explained; pin matches the lockfile (5 new tests) |

## Findings

1. **Node SEA meets the requirements without third-party binaries.** `@yao-pkg/pkg` was not tried: it downloads
   prebuilt Node binaries from its own release channel, which adds a supply-chain source, and SEA already did
   everything needed (ESM import from disk included). Revisit only if SEA's size or behaviour becomes a problem.
2. **Official macOS Node binaries are universal (x86_64 + arm64), 233 MB.** The SEA fuse appears twice and postject
   refuses. Thinning to the host architecture with `lipo` fixes it and halves the size.
3. **Size is the main cost:** 117 MB for the sidecar versus 4.3 MB for the app itself. Installers compress it (to be
   measured at R1). Possible reductions for later: stripping symbols before injection, or another runtime (Bun or Deno
   compile), which would need its own spike.
4. **pnpm 11 fails `--frozen-lockfile` when a dependency's install script is ignored** (esbuild). The fix is an explicit
   `allowBuilds: { esbuild: false }`; esbuild's platform package already provides the binary.
5. **`tauri-build` requires every `externalBin` to exist**, even for `cargo clippy` and `cargo test`. CI builds the
   sidecar before the Rust steps, and `pnpm dev`/`pnpm build` build it automatically.
6. **Finder launches have a minimal PATH, but the known-locations fallback in `findClaude()` covers the native
   installer.** The user's shell environment (e.g. `ANTHROPIC_API_KEY` set in `.zshrc`) is still **not** inherited. That
   is M1-03 (login-shell env resolution).
7. **macOS signing:** the sidecar is ad-hoc signed after injection. Developer ID signing and notarization of the
   externalBin happen at R1-03.
8. **A stalled download hung session start.** A later local smoke run sat in `sdk.prepare` for 10 minutes on a
   flaky network. The download (body included) now has a 120 s deadline and a clear error, and the next session
   retries. Unit-tested with a fetch that never answers.

## Not covered yet

- [ ] Full app with a signed-in CLI on Windows and Ubuntu, including `%USERPROFILE%\.local\bin\claude.exe` discovery.
      CI covers the packaged sidecar and SDK download there, but not a Claude session (no CLI login on runners).
- [ ] Behind an HTTP proxy: `NODE_USE_ENV_PROXY=1` is set, but this hasn't been tested yet.
- [ ] Installer sizes (dmg/msi/AppImage) and signing at R1.

## Decision

Ship the sidecar as a **Node SEA per target triple via `bundle.externalBin`**, with the **Agent SDK downloaded,
verified and cached on first use**. ADR-0003 is accepted.
