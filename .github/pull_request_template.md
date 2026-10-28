## What and why

<!-- One or two sentences. The PR title becomes the commit message on main:
     Conventional Commits + checklist IDs, e.g. "feat(sidecar): add env.check [M0-19]". -->

## Checklist items and evidence

<!-- For every item ticked in docs/CHECKLIST.md: what proves it (test run, spike doc, CI run, screenshot). -->

- [ ] `Mx-NN`: evidence…

## How I verified it

- [ ] `pnpm lint && pnpm typecheck && pnpm test`
- [ ] `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
- [ ] Checked in the running app (describe what), if the UI or sidecar behaviour changed
- [ ] No raw SDK recordings, personal paths or secrets added (fixtures only via `make-fixture.ts`)

## Not done / follow-ups

<!-- Risks, open questions, anything skipped. Don't claim checks that weren't run. -->
