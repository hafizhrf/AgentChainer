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
| **Idle memory** | Resident memory of the app's whole process tree (the app, the sidecar, the WebView's processes) after 20 s idle on Home | **600 MB** on Windows and Linux; **400 MB** on macOS, where the WebView's processes aren't the app's children and aren't counted (verify) | `scripts/perf-budgets.mjs` |
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
- **Windows** (`windows-latest`): startup 1.2 s; idle memory 419 MB (WebView2 298, sidecar 74, app 41).
- **Ubuntu 22.04 under Xvfb:** startup **31 s** and idle memory **691 MB**, both over budget.
  - The UI was ready 226 ms after its page started loading, so the 31 s went before the WebView loaded anything. A
    likely cause is an environment timeout on the runner, such as GTK waiting for an accessibility bus that Xvfb
    doesn't run (verify).
  - The script now prints the app's log with timings when startup is over budget, to tell where it went.
- **macOS:** not measured yet. The hosted macOS runners couldn't be acquired at the time.

Adjust the Ubuntu and macOS budgets once a few runs are in, or fix what's slow.

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
