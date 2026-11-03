# Eval report

App 0003f2d322776aeab469efd8d6a7cebd676a270e, 2026-11-03. 7 cases × N=3 from `packages/sidecar/test/evals/suite.json`; spent ≈$0.75 of a $6.00 cap.

A run passes when every acceptance check exits 0, including the hidden ones the agent never saw.

| Variant | Model | Workflows | Passed | 95% interval | Cost per run | Cost per pass | Median time | Fix rounds |
|---|---|---|---|---|---|---|---|---|
| main | haiku | catalog/workflows@origin/main | 21/21 (100%) | 85%–100% | $0.019 | $0.019 | 25 s | 0 |
| branch | haiku | the app's | 21/21 (100%) | 85%–100% | $0.017 | $0.017 | 24 s | 0 |

## Against main

| Variant | Pass rate (points) | Cost per run | Reading |
|---|---|---|---|
| branch | 0 (-15 to +15) | −$0.002 (−$0.018 to +$0.014) | no clear difference in passes; no clear difference in cost |

## By case

| Case | main | branch |
|---|---|---|
| sample-quantity | 3/3 · $0.007 · 22 s | 3/3 · $0.007 · 22 s |
| sample-discount-clamp | 3/3 · $0.008 · 24 s | 3/3 · $0.008 · 23 s |
| sample-with-tax | 3/3 · $0.009 · 31 s | 3/3 · $0.008 · 27 s |
| sample-format-cents | 3/3 · $0.008 · 23 s | 3/3 · $0.008 · 25 s |
| sample-validate-items | 3/3 · $0.085 · 40 s | 3/3 · $0.073 · 45 s |
| go-sub | 3/3 · $0.007 · 25 s | 3/3 · $0.007 · 21 s |
| go-clamp | 3/3 · $0.008 · 24 s | 3/3 · $0.008 · 29 s |

## Runs that passed the checks but not by the task's own verdict

- main / go-sub: 3 runs failed; failed gates: lint `make lint`, test `make test`
- branch / go-sub: 3 runs failed; failed gates: lint `make lint`, test `make test`
- main / go-clamp: 3 runs failed; failed gates: lint `make lint`, test `make test`
- branch / go-clamp: 3 runs failed; failed gates: lint `make lint`, test `make test`

## Inputs

sha256 of the first-party files a task run reads, at the app commit:

- `catalog/workflows/l.yaml` 4d46aeda826e
- `catalog/workflows/m.yaml` 6799598afcdd
- `catalog/workflows/s.yaml` 740aec8fdcbe
- `catalog/workflows/xl.yaml` 942d3015b554
- `agents/ac-architect.md` 3ff02039a3a1
- `agents/ac-docs-writer.md` 4527d94390ba
- `agents/ac-implementer.md` 7eff58e0454d
- `agents/ac-independent-reviewer.md` a619adcbf29d
- `agents/ac-security-reviewer.md` b6abab8b222d
- `agents/ac-test-planner.md` 787927f21bab
