# Performance budgets (X-07)

Three numbers are tracked for every release:
- how long the app takes to start;
- how much memory it holds while idle;
- how fast streamed text reaches the screen.

The budgets live in [`scripts/perf-budgets.json`](../scripts/perf-budgets.json), per platform. Two scripts check them.

## The budgets

| Measure | What it covers | Budget | How it's measured |
|---|---|---|---|
| **Startup** | From the process starting to Home being ready: the window, the UI, the sidecar's handshake, and the readiness check (CLI, login, git) | **6 s** | `scripts/perf-budgets.mjs`, debug build, no model call |
| **Idle memory** | Resident memory of the app's whole process tree (the app, the sidecar, the WebView's processes) after 20 s idle on Home | **600 MB** on Windows; **850 MB** on Linux, where WebKitGTK runs partly inside the app; **400 MB** on macOS, where the WebView's processes aren't the app's children and aren't counted (verify) | `scripts/perf-budgets.mjs` |
| **Stream latency** | p95 of the time from the sidecar sending a text delta to the UI receiving it, over one real turn | **50 ms** | `scripts/selftest-latency.mjs`, one haiku turn (macOS and Linux; it reads CPU with `ps`) |

## How they were set

All the numbers below are from a debug build. A release build starts faster.

**Windows 11** (2026-11-05):
- **Startup:** 1.6–1.7 s warm, 3.7 s for the first launch after a build.
- **Idle memory:** 475–486 MB. That's the WebView2 processes at about 355 MB, the sidecar (Node) at about 73 MB, the
  app at about 42 MB, and a console host at about 8 MB.
- **Stream latency** (spike S2, [S2-S3-chat-slice.md](spikes/S2-S3-chat-slice.md)): p50 1 ms, p95 2–3 ms, max 4–16 ms.

Each budget leaves room for slower machines and hosted CI runners:
- **Startup:** about 3.5 times the warm figure, and well above the cold one.
- **Idle memory:** about a quarter above the measured total.
- **Stream latency:** an order of magnitude above S2. Past it, delays start to be visible while text streams.

The first CI figures (PR #120, debug build, no Claude CLI on the runner, so readiness didn't pass):
- **Windows** (`windows-latest`): startup 1.2 s; idle memory 418–419 MB (WebView2 about 300, sidecar 72–74, app
  38–41).
- **macOS** (`macos-latest`, arm64): startup 2.1 s; idle memory 221 MB (app 106, sidecar 115). The WebView's
  processes aren't counted, as said above.
- **Ubuntu 22.04 under Xvfb:** startup **31–32 s** and idle memory **666–691 MB**.
  - **The 30 s is before the app's own code.** The app's log shows nothing until its first line, `[core] AgentChainer
    … starting`, at about 30.7 s. That line comes from `setup`, which runs once the window system, the WebView and the
    plugins are up. The UI itself was ready 0.2–0.5 s after its page started loading.
  - **It isn't the notification plugin (M8-05):** the launch smoke test's screenshot, taken at 15 s, is black both
    before and after that plugin came in.
  - **It isn't GTK's accessibility bus either.** The first run logged `AT-SPI: Error retrieving accessibility bus
    address`. CI's Linux step now sets `NO_AT_BRIDGE=1`, which removed the warning but not the wait.
  - **The cause is open:** it's in GTK, WebKitGTK or a plugin's start on the Xvfb runner. It needs checking on an
    Ubuntu desktop, with the Ubuntu click-through (verify). Until then, Linux startup on CI doesn't count against the
    budget.
  - Memory splits as the app 173 MB (WebKitGTK runs partly in-process), the WebView 378 MB, and the sidecar 115 MB.
    The Linux budget is 850 MB: about a quarter above that, as for Windows.
  - The script prints the app's log with timings whenever startup is over budget.
- **macOS:** not measured yet. The hosted macOS runners couldn't be acquired at the time.

Adjust the macOS budget once a few runs are in, and the others when releases show a trend.

## Running them

```bash
# After a debug build (pnpm --filter @agentchainer/desktop tauri build --debug --no-bundle):
node scripts/perf-budgets.mjs [--binary target/debug/agentchainer] [--idle 20] [--json perf.json] [--warn-only]
node scripts/selftest-latency.mjs --cwd <empty scratch dir>   # one real haiku turn; macOS/Linux
```

- `perf-budgets.mjs` exits 1 when a budget is exceeded, or 0 with `--warn-only`.
- `selftest-latency.mjs` fails when the p95 is over its budget.

## Tracking

- **CI:** every run's Build & launch job measures startup and idle memory on macOS, Windows and Ubuntu with
  `--warn-only`, and keeps `perf-<OS>.json` in the job's artifact. It doesn't block a pull request, because hosted
  runners vary too much for a hard gate.
- **Releases:** before a release is published, [RELEASING.md](RELEASING.md) has both scripts run on a debug build
  of the release commit. Their numbers go in the release's notes. An exceeded budget is fixed first, or the budget is
  changed here, with a reason.
