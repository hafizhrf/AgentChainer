# Design: git workflow, pull requests and quality gates (M5)

- **Status:** Approved (2026-11-01). The owner made four decisions up front (§15) and approved the draft (#61).
- **Date:** 2026-11-01
- **Covers:** M5-01…M5-06 and the exit criterion M5-E1. Scope source:
  PRD [F5](../PRD.md#f5--git-workflow-prs-and-quality-gates-p1).
- **Builds on:**
  - M3's task contracts, gates, independent review and evidence report ([planner.md](planner.md));
  - the XL worktrees of M3-07 (`tasks/xl.ts`, `tasks/worktree.ts`);
  - [ADR-0002](../adr/0002-auth-and-branding.md): the app never logs in for the user or stores tokens. It uses the
    user's own signed-in CLI.

## 1. What problem this solves

A task ends today as uncommitted changes in the working tree. That holds for tiers S, M and L, which run in the
workspace itself (`startTask` in `tasks/service.ts:318` and `codeRootOf` at `:249`). Only XL makes a branch.

Between "the gates passed" and "it's merged" there is nothing:
- no branch the work lives on;
- no pull request carrying the contract and the evidence;
- no CI result;
- no gate that a human clicks through.

Two tasks can't run side by side, because they share one tree.

## 2. The user's flow

1. A task is approved and runs in **its own worktree and branch**, whatever its tier.
2. Gates, review and the evidence report run as in M3, inside that worktree.
3. On the task page, **Create PR**:
   - pushes the branch;
   - opens a pull request whose body is the contract plus the evidence;
   - shows the body for review before it's sent.
4. The page shows the PR's **CI checks** while it's open.
5. When CI fails, **Fix CI** shows the failing log and asks before each round. Claude fixes it, the local gates run
   again, and the branch is pushed again.
6. The **merge gates** show what stands between the PR and Merge: local gates, review of the PR diff, scanners and CI.
7. **Merge** is a human click with a confirmation, and only when the gates are green or their risk was accepted.
8. **Clean up** removes the worktree, and the branch if the user wants.

Without GitHub (no `gh`, or a remote elsewhere), steps 3–7 are replaced by the existing local **Merge** into the
current branch, now offered for every tier.

## 3. A worktree per task (M5-01)

- **Every tier runs in a worktree.** `.agentchainer/worktrees/<id>` on the branch `agentchainer/<id>` (`worktree.ts:14`,
  `:17`), made from HEAD.
  - This generalises XL's `prepare` (`xl.ts:176`). It adds the worktree, runs the project's install command under the
    workspace guard, and runs the baseline gates there.
  - `codeRootOf` then points at the worktree for every task. Steps, gates, the transcript and the evidence all run
    there.
- **The run's result is one commit.** `commitAll` (`worktree.ts:66`) makes it with the contract's objective as the
  message.
  - It runs when the result leaves the worktree: on Merge, on Clean up (so removing the folder loses no work), and from
    step 2 on Create PR. A run that is run again in the same worktree keeps adding to the same, uncommitted change.
  - It stages everything except `.agentchainer/` and the files that were untracked at the start, as today.
  - The user's commit hooks run. A hook that fails stops the Merge or the Clean up with its message.
- **Parallel tasks are allowed.** While two tasks are live, the page compares the files each one has changed (`git diff
  --name-only` against its base). When they overlap, it shows a warning naming the files. Nothing is blocked; the
  overlap turns into a merge conflict only if both are merged.
- **The local result.** `mergeResult` (`service.ts:594`) works for every tier, not only XL.
  - It merges the task branch into the current branch (`git merge --no-edit`).
  - It still requires a run that is Done or accepted, and a clean tree.
- **Clean up stays manual:** a button on the result card. It removes the worktree and, if asked, the branch
  (`cleanupTask`).
- **A run that just ended:** its end is saved before its sessions close. Merge and Clean up wait for that, so a click
  right after the end doesn't hit "still running" or a folder Windows won't remove (`settleRun`).
- **No git:** a workspace without a repository, or without a commit, runs the task in place as before.
- **Effects on M3:**
  - The workspace's own changes panel no longer shows a task's work. The task page shows it, from the worktree's diff
    against its base.
  - An XL task is unchanged; its sub-tasks already work this way.

## 4. GitHub through the user's `gh` (owner decision 1)

- **Detection, like the `claude` CLI (ADR-0002):**
  - `gh --version`, then `gh auth status --hostname <host>`;
  - the host comes from the task's push remote (`github.com`, or a GitHub Enterprise host the user is signed in to);
  - the app never passes `--show-token` and never reads `gh`'s config or credentials.
- **When it's missing:** a guide, `docs/guides/GITHUB_SETUP.md`. It has copyable commands per OS (install `gh`, then
  `gh auth login` in the user's own terminal) and a **Re-check** button.
- **One wrapper runs every call:**
  - `spawnSync` with an argument array, never a shell;
  - `GH_PROMPT_DISABLED=1`, `NO_COLOR=1` and `GH_NO_UPDATE_NOTIFIER=1` set;
  - a timeout;
  - JSON output (`--json <fields>`) wherever `gh` offers it.
- **Flags.** All of these were checked against `gh` 2.103.3 (2026-10-26):
  - `pr create --base --head --title --body-file --draft`;
  - `pr view --json number,url,state,isDraft,headRefOid,mergeStateStatus,reviewDecision`;
  - `pr checks --json name,state,bucket,link,workflow,startedAt,completedAt`;
  - `run view --job <id> --log-failed`;
  - `pr merge --merge|--squash|--rebase --match-head-commit <sha>`;
  - `repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerDefaultMergeMethod`.
  The minimum version the app requires is still open (§15).

## 5. Create PR (M5-02)

1. **Secrets check before anything leaves the machine.** gitleaks over the branch's changed files, as the evidence
   already does (`scanSecrets`, `service.ts:651`). A finding blocks the push until the user accepts it with a reason.
2. **Push:** `pushBranch` in `git.ts`. As built: to an https GitHub remote it uses the user's `gh` login as the
   credential helper for that one command, so it doesn't depend on how git's own helper is set up. Every network call
   (`git push`/`fetch`/`pull`, `gh`, the scanners) runs without blocking the sidecar: the UI restarts a sidecar that
   doesn't answer its health ping within 5 s (M1-01), and a blocking push did exactly that.
   - It sets `-u origin agentchainer/<id>` and never forces.
   - It uses the user's own git credential helper, with `GIT_TERMINAL_PROMPT=0`.
3. **The pull request:** `gh pr create`.
   - Base: the branch the task started from. Head: the task branch. Title: the contract's objective.
   - Body: a file under `.agentchainer/tasks/<id>/`, containing:
     - the contract: objective, acceptance criteria, scope and out of scope;
     - the evidence report, as rendered by `renderEvidence` (`evidence.ts:265`): gates, review findings, the secrets
       scan, accepted risk and the approvals that were asked;
     - a footer, "Generated by AgentChainer".
   - **Draft** by default, with a checkbox for ready for review.
4. **Preview:** the dialog shows the title, base and body before anything is sent. Only the title can be edited; the
   sidecar builds the body again when it sends it (`prBody`).
5. **The task records the PR:** `pr {number, url, base, head, headSha}`. A PR that already exists for the branch is
   picked up instead of a second one.

New requests (names settled in the step's PR):
- `task.prepareShip`: detection, the secrets scan, and the body preview;
- `task.createPr`;
- `task.prStatus`: the PR and its checks;
- `task.ciLog`;
- `task.fixCi`;
- `task.mergePr`.

Each one takes the task, never a path or a `gh` argument from the UI.

## 6. CI status and Fix CI (M5-03, owner decision 3)

- **Status:**
  - The page polls `task.prStatus` while it's open: every 30 s, backing off to 2 min when nothing changes.
  - Polling stops once every check has a final state, and nothing polls with the page closed.
  - The checks use `gh`'s `bucket` field (`pass`, `fail`, `pending`, `skipping`, `cancel`).
- **Fix CI** is offered when a check's bucket is `fail`. Each round asks the user first:
  1. Read the failing job's log: `gh run view --job <id> --log-failed`, where the job comes from the check's `link`.
     Keep the last 32 KB, then redact it with the diagnostics patterns (home folder, keys, tokens, emails).
  2. Show the log, and ask: **Fix this** or **Not now**.
  3. Run a fix step in the worktree, with the role `ac-implementer`. Its permission mode, approvals and guard are the
     task's.
     - The log is passed as data in a fenced block, marked as output to read, not instructions to follow.
     - A CI log can carry text from anyone who can change the repository, so it is prompt-injection input (T-02).
  4. Run the local gates, then commit and push (no force).
  5. Watch CI again.
- **As built:**
  - a round is an Orchestrator entry (`fixCi`): a `ci-fix` step with the write step's role, then the gates once;
  - when it ends Done, the service commits and pushes; a push that fails ends the round failed and says why;
  - each round is recorded on the PR (`pr.fixes`) and in the run's timeline and evidence;
  - only GitHub Actions checks have a log the app reads (`jobOf`); other CI gets a link to its page.
- **Limits:**
  - at most 3 rounds per PR;
  - every round counts against the task's budget cap (T-11);
  - every round, with its log excerpt, its diff and its gate results, is added to the evidence.

## 7. Merge gates (M5-04)

The Merge button is enabled when every gate below is green, or its risk was accepted with a reason (as in M3-09):

| Gate | What runs | Notes |
|---|---|---|
| Local gates | the run's format, lint, typecheck, test and build | As in M3, against the baseline |
| Review of the PR | `ac-independent-reviewer` over `git diff <base>...<head>` | A verdict without must-fix findings. S gets a review here for the first time; M and L reuse theirs when the head hasn't changed since |
| Secrets | gitleaks over the PR's changed files | Already run before the push; runs again if the head changed |
| Static analysis | semgrep and trivy, **only if installed** (`findTool`: the tools folder, then PATH) | Not added to the catalog in M5. Pinning them later follows [ADR-0005](../adr/0005-catalog-trust-model.md). Not installed means the page says "not run", not "passed" |
| CI | every check in bucket `pass` or `skipping` | Pending checks keep Merge disabled |

Each result is shown on the page with what it covers, and appended to the evidence.

As built (decided by the implementer, 2026-11-01):
- **Offline scanners.** semgrep runs only with the repository's own rules (`.semgrep.yml`, `.semgrep.yaml` or
  `.semgrep/`), with `--metrics=off`. trivy runs with `--offline-scan --skip-db-update`, so it needs a database already on
  the machine. Neither reaches the network from the app; registry rules and database downloads stay the user's own step.
- **The gates are worked out when asked** (`task.mergeGates`), not polled. They are worked out again inside
  `task.mergePr`, for the head the person saw.
- **The review** counts for the head it covered. The run's own review (M and L) counts for the head Create PR pushed.
  **Review the PR** runs the reviewer on the PR's diff for any tier (`Orchestrator.reviewPr`, ≈$0.07 with the shipped
  role).
- **The scanners** run on the task's worktree only while it is at the PR's head. Otherwise they say so, and don't hold
  Merge back.

## 8. Human-only operations (M5-05, owner decision 2)

- **Merge:** only a person, by clicking **Merge** and confirming.
  - The dialog shows the method. The default is `viewerDefaultMergeMethod`, and the methods the repository allows are
    offered.
  - The app runs `gh pr merge <number> --<method> --match-head-commit <sha>`, so it merges only the commit the gates
    passed.
  - No `--auto`.
- **Force-push and release tags:** the app has no command for either.
- **The agent can't do any of these.** The guard already blocks force-pushes (`guard.ts:50`). It is extended to deny,
  in agent sessions:
  - `gh pr merge`;
  - `gh release`;
  - `gh api` calls that write;
  - `git tag` with a name;
  - `git push --tags`.

## 9. GitLab (M5-06, optional)

- The PR, status, log and merge calls go through a small provider interface (`detect`, `createPr`, `status`, `log`,
  `merge`), with `gh` as its first implementation.
- A `glab` provider can follow the same rules: the user's own login, no tokens, argument arrays.
- It is deferred until after E1.

## 10. UI

- **The result card** on the task page becomes **Branch & PR** for every tier (today `ResultCard`, XL only,
  `TaskPage.tsx:1541`). It shows:
  - the branch and its commits;
  - Create PR, or the PR link and its state (draft or open);
  - the checks list;
  - Fix CI;
  - the merge gates;
  - Merge and Clean up.
- **The overlap warning** sits at the top of the page while another live task touches the same files.
- Light and dark from the existing tokens; every action is reachable with the keyboard (X-12).

## 11. Security and privacy

- **New network use, always from the user's click or while the task page is open:**
  - `git push` to the task's remote;
  - `gh` calls to the GitHub API on the user's account.
  The step that adds each one adds its row to [PRIVACY.md](../PRIVACY.md) in the same PR.
- **THREAT_MODEL:**
  - a GitHub edge in the trust-boundary diagram;
  - the new requests and the `gh` wrapper in the IPC surface;
  - new threats:
    - a CI log as injection (§6);
    - a PR body or push leaking secrets (gitleaks first, §5);
    - `gh` acting with the user's full rights, which is why the app sends only the fixed commands above, built from
      the task;
  - the guard's new rules (§8).
- **No tokens and no login** (ADR-0002). The app only detects `gh auth status`.

## 12. Testing

- **A fake `gh`:** a script put on PATH in tests, in the style of `bootstrap/fake-cli.ts`. It records its arguments and
  answers with fixed JSON. Tests cover:
  - detection and the missing or signed-out states;
  - create, including picking up an existing PR;
  - checks in each bucket;
  - logs with redaction;
  - merge with `--match-head-commit`.
- **Worktrees for every tier:** `service.test.ts` and `orchestrator.test.ts` run S, M and L in worktrees. The local
  merge, the overlap warning and cleanup are covered.
- **The guard:** cases for every new denied command.
- **E1:** a private test repository on the owner's GitHub, with a workflow that runs its tests.
  - `live-task.ts` gets `--pr`: task → worktree → gates → PR → CI → Fix CI (once, on purpose) → green.
  - The owner merges by hand in the app.

## 13. Delivery

One PR per step, each merged before the next starts:

1. **A worktree for every tier**, with the local Merge and the overlap warning.
2. **`gh` detection, the guide, push and Create PR**, with PRIVACY and THREAT_MODEL.
3. **CI status and Fix CI.**
4. **Merge gates and the human Merge**, with the guard rules.
5. **E1** on a test repository.
6. **GitLab** (optional).

## 14. Alternatives considered

| Option | Why not |
|---|---|
| GitHub's API with a token the app stores | ADR-0002: the app never stores tokens; `gh` already holds the user's login (§15) |
| Merge only on GitHub's site | The owner chose a Merge button with confirmation (§15) |
| Fix CI that runs on its own for a few rounds | The owner chose an approval per round (§15) |
| S tasks in the working tree | No branch, so no PR; the owner chose a worktree for every tier (§15) |
| semgrep and trivy in the catalog now | They need pinned, hashed sources (ADR-0005); "if installed" covers M5 |
| `gh pr merge --auto` | It merges later without a person; M5-05 asks for a human at the moment of merging |

## 15. Decisions

**Decided** by the owner, 2026-11-01:
1. **GitHub through `gh` only.** The user signs in with `gh auth login`; the app detects it and never handles tokens.
2. **Merge:** a Merge button that runs `gh pr merge` after the user confirms, enabled only when the gates and CI are
   green. The app never merges on its own.
3. **Fix CI:** every round shows the log and asks first; at most 3 rounds, within the task's budget.
4. **A worktree for every tier:** `.agentchainer/worktrees/<id>` on `agentchainer/<id>`.

**Still open:**
- the minimum `gh` version (the flags above are in 2.103.3);
- whether a new PR is a draft by default (proposed: yes);
- the polling interval (proposed: 30 s, backing off to 2 min);
- the repository for E1.
