---
name: ac-smoke-test
description: Add a quick smoke test that proves the app still starts - a script plus a CI job. Used by AgentChainer's workspace bootstrap.
---

# Add a smoke test

You propose `scripts/smoke.sh` (or `scripts/smoke.mjs` / `scripts/smoke.py` when that runtime is the project's own),
and optionally a `smoke` job in `.github/workflows/smoke.yml`. You don't write files: you return them.

## What "smoke" means per project type

- Web server or API: start it on a free port, wait up to 30 s for a health or root URL to answer, then stop it.
- CLI: run it with `--help` (or `--version`) and check the exit code.
- Library: import or build it and call one public function.
- Flutter app: `flutter build` for one platform, or `flutter test` if building isn't possible in CI.

## Rules

- The script must finish in under 60 seconds, clean up every process it started (even on failure), and exit non-zero
  with a clear message when the check fails.
- Use the project's detected commands; don't install new tools.
- No secrets, no network calls beyond localhost.
- If you add a CI job, follow the same rules as the CI generator: `permissions: contents: read`, SHA-pinned actions
  only from `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1` and
  `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`, and `timeout-minutes`.
