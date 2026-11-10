# Compatibility

What AgentChainer runs on and with (X-08). `scripts/check-compatibility.mjs` fails CI when the CLI minimum or the SDK
pin here differs from the code, so a bump updates this page too.

## Your computer

| | Supported | Checked |
|---|---|---|
| **macOS** | Apple silicon and Intel, with the WKWebView that ships with macOS | By hand on macOS 26.5 (Intel). CI builds and launches the app on `macos-latest` **(verify: the runner's macOS version)**. |
| **Windows** | Windows 10 and 11, 64-bit, with Microsoft Edge WebView2, which the installer downloads when it's missing **(verify)** ([INSTALL](guides/INSTALL.md)) | By hand on Windows 11, with WebView2 from Edge 156. CI builds and launches on `windows-latest`. |
| **Linux** | Ubuntu and Debian (`.deb`), with WebKitGTK 4.1, so Ubuntu 22.04 or newer | CI builds and launches on Ubuntu 22.04. The exit criteria still wait for a hand run on Ubuntu (M1, M4-E2). |

You don't need Node.js: the app ships its runtime as a single executable (spike S1).

**Behind an HTTP proxy:** the app's own downloads follow `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` from your login
shell. CI checks this on all three OSes with `scripts/proxy-smoke.mjs`:
- through a proxy, the download works;
- with a dead proxy, it fails, so nothing goes around the proxy;
- `NO_PROXY` is honoured.

See [INSTALL](guides/INSTALL.md#behind-a-proxy).

## Claude Code CLI

AgentChainer drives your own `claude` CLI, signed in by you ([AUTH_SETUP](guides/AUTH_SETUP.md)).

- Minimum: **2.1.293**. The readiness check enforces it: an older CLI shows "Version older than 2.1.293", and the
  fix is `claude update`.
- Used by hand so far: 2.1.293 (macOS) and 2.1.314 (Windows 11).
- Newer versions are checked every week. The **Drift** workflow (`.github/workflows/drift.yml`) runs the newest CLI
  through every command and flag the app uses (`packages/sidecar/src/cli-contract.ts`) and opens an issue when one
  goes missing.

## Codex and the Antigravity CLI (optional)

Task steps can run on your own Codex CLI or Antigravity CLI (`agy`), each signed in by you
([ADR-0012](adr/0012-multi-agent-backends.md)). Neither is required.

- Used by hand so far: Codex **0.157.0** and agy **1.5.4** (Windows 11).
- **Codex** is checked every week by the same Drift workflow. The newest `@openai/codex` from npm is installed without
  install scripts, and its app-server's protocol, generated as JSON Schema with no login, is checked against every
  method, value and field the app uses (`packages/sidecar/src/backends/contracts.ts`).
- **agy** has no package the workflow can install without running an install script, so its flags are checked by
  hand: `node packages/sidecar/scripts/cli-contract.ts --skip-claude --agy <path to agy>`.

## Agent SDK

- Pinned: **0.3.311**. The packaged app downloads exactly this version from npm on first run and checks its
  integrity hash ([ADR-0003](adr/0003-agent-runtime-and-ipc.md)).
- Newer versions are checked every week by the same Drift workflow: the sidecar is moved to the newest SDK that pnpm
  accepts (its minimum release age stays on), then typechecked and tested against the recorded fixtures. Moving the
  pin is a normal pull request (`node packages/sidecar/scripts/pin-sdk.ts`).

## Other tools

| Tool | Needed for |
|---|---|
| `git` | Required: the changes and git panels, task branches and worktrees |
| GitHub's `gh`, signed in by you | Pull requests, checks and merges (M5); optional |
| Vercel, Cloudflare `wrangler`, Firebase, `flyctl`, Docker | Deploys (M6), each only for its own adapter; optional |

## Building from source

Node 24 (`.node-version`), pnpm 11 (`packageManager`), Rust stable (`rust-toolchain.toml`) and the
[Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/). See [CONTRIBUTING](../CONTRIBUTING.md).
