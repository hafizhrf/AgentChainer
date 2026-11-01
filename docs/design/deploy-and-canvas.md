# Design: deploy adapters and the workflow canvas (M6)

- **Status:** Approved (2026-11-01). The owner made four decisions up front (§15) and approved the draft (#69).
- **Date:** 2026-11-01
- **Covers:** M6-01…M6-04 and the exit criterion M6-E1. Scope source: PRD
  [F6 and F7](../PRD.md#f6f9-p2).
- **Builds on:**
  - M5's worktree per task and its PRs ([git-workflow.md](git-workflow.md));
  - [ADR-0002](../adr/0002-auth-and-branding.md): credentials stay in each provider's own CLI;
  - the gates and the guard (`tasks/gates.ts`, `guard.ts`);
  - M4's React Flow graph, for the canvas.

## 1. What problem this solves

A change that passed its gates and its review still has to be deployed by hand. There is no preview link on the
task, no check after the deploy, and no quick way back. The guard already keeps agents from deploying
(`guard.ts:75-83`, "deploy flow arrives in M6"), but the app has no deploy flow of its own yet.

The tier workflows (S, M, L, XL) are also fixed in the app. A team can't add a security review to M, or make S run
the docs writer, without changing the app.

## 2. The user's flow

**Preview, from a task:**
1. The task page's Deploy card shows the adapter it found (e.g. Vercel) and that its CLI is signed in.
2. **Deploy preview** deploys the task's worktree as a preview.
3. The deployment URL comes back, and the smoke test runs against it.
4. The result is on the task and in its evidence.

**Production, from the workspace:**
1. The workspace's Deploy page shows the plan: the command, the project and the target.
2. The person types the project's name to enable **Deploy to production**.
3. The deploy runs, then the smoke test.
4. **Roll back** is one click away, with a confirmation, while the deploy is the latest.

## 3. The adapter interface (M6-01)

Each provider is an adapter with the same five steps:

| Step | What it does |
|---|---|
| `detect(root)` | The provider's config files, its CLI (found with `findTool`), and whether the CLI is signed in through a `whoami`-style check. Never the account name or a token. |
| `plan(env)` | The exact command, arguments and target, shown before anything runs. |
| `deploy(plan)` | Runs the CLI with `runAsync` (an argument array, no shell, never blocking the sidecar, #67). Reads the deployment URL and the provider's deployment or version id from its output. |
| `smoke(url)` | §6. |
| `rollback(record)` | The provider's own rollback to the deployment recorded as the previous one. |

**Running provider CLIs:**
- vercel, wrangler and firebase install as npm `.cmd` shims on Windows. Node can't spawn those without a shell. The
  shim is read and resolved to `node <script>`, as `exeFromNpmShim` does for `claude` (`claude.ts`); the app never
  runs them through `cmd /c`. Checked: wrangler's shim ends with `"%dp0%\node_modules\wrangler\bin\wrangler.js" %*`.
- Every call sets the provider's no-prompt flag (`--yes` or `CI=1`), has a timeout, and has its output capped.
- The flags below were checked against **wrangler 4.58.0**, and the Vercel ones against **Vercel CLI 65.9.0** (through
  `npx`, without installing or signing in).
- As built (step 1): the CLIs run with `CI=1`, `NO_COLOR` and the providers' telemetry off
  (`VERCEL_TELEMETRY_DISABLED`, `WRANGLER_SEND_METRICS=false`), and `node` for a shim is the one on PATH (the sidecar's
  own executable isn't a Node a CLI can run on). Checked live: `wrangler`'s shim ran as
  `node …\wrangler.js --version`.

## 4. The first adapters (owner decision 1)

**Vercel:**
- detect: `.vercel/project.json` (linked) or `vercel.json` (asks for `vercel link` first); `vercel whoami` exits 0;
- **a task's worktree gets the workspace's `.vercel/project.json`**: `.vercel/` is usually ignored by git, and without
  it `vercel deploy --yes` would make a new project named after the worktree's folder;
- preview: `vercel deploy --yes` prints the deployment URL on stdout **(verify the output on a live deploy)**;
- production: `vercel deploy --prod --yes`;
- rollback: `vercel rollback <deployment> --yes` (an id or a URL);
- status: `vercel inspect <url> --json --wait`.

**Cloudflare (Workers and Pages), through wrangler:**
- detect: `wrangler.toml`, `wrangler.json` or `wrangler.jsonc`; `wrangler whoami`.
- **Workers:**
  - preview: `wrangler versions upload --preview-alias <task id> --message <objective>`. It uploads a version without
    sending traffic to it and gives a preview URL;
  - production: `wrangler versions deploy --version-id <id> --yes`;
  - rollback: `wrangler rollback <previous version id> --message <reason> --yes`.
- **Pages:** `wrangler pages deploy <dir> --project-name <name> --branch <task branch> --commit-hash <sha>`. A
  non-production branch is a preview; Pages rollback is through the dashboard or its API **(verify a CLI path)**, so
  Workers come first.
- Which of the two applies is read from the config: Workers have `main`, Pages have `pages_build_output_dir`
  **(verify)** (§15).
- **As built (step 2):** Workers only. A config with `pages_build_output_dir` is shown with "Pages deploys come
  later". The preview alias is `task-<last 8 characters of the task id>` (aliases are lowercase letters, digits and
  dashes), and the message is the objective, cut to 100 characters. The URL and the version id are read from the
  `Version Preview Alias URL:` and `Worker Version ID:` lines. `wrangler whoami` exits 0 even when signed out, so its
  text is checked for "not authenticated" too (only the result is kept). A Worker that was never deployed has no
  versions to preview: the card says to run `wrangler deploy` once by hand, and the app never does a first deploy
  on its own. Whether production promotes the previewed version (`versions deploy`) or runs `wrangler deploy` is
  settled in step 3.

**Later in M6:**
- Fly.io: `fly deploy`, `fly releases`, rollback by redeploying the previous image;
- Docker → registry: `docker build` and `docker push` to a registry the user names; no rollback beyond the tag;
- Firebase Hosting: `hosting:channel:deploy` for previews, rollback through `hosting:clone` of the previous release
  **(verify)**.

**As built (step 4), Firebase Hosting and Fly.io:**
- **Firebase Hosting** (checked against firebase-tools 15.34.2's help and source, not a live deploy):
  - detect: `firebase.json` with `hosting`, and a default project in `.firebaserc` (else "run `firebase use --add`");
    one Hosting site for now;
  - signed in: `firebase login:list`, which exits 0 either way, so its text is checked for "No authorized accounts";
  - preview: `hosting:channel:deploy task-<id> --expires 7d --non-interactive --json`, read from the JSON's `url` and
    `version`;
  - production: `deploy --only hosting --message <objective> --non-interactive --json`, whose result is the live
    release's `projects/<p>/sites/<site>/versions/<id>`; the URL is `https://<site>.web.app`;
  - rollback: `hosting:clone <site>@<previous version> <site>:live`. Firebase has no "previous" of its own, so this
    needs the version the app recorded.
- **Fly.io** (flags from the flyctl reference on docs.fly.io; **not checked against an installed flyctl**):
  - detect: `fly.toml` with `app`; signed in: `fly auth whoami`'s exit code;
  - **no previews**: Fly deploys to production only, so the task's Deploy card leaves it out;
  - production: `fly deploy --remote-only --yes`, building on Fly's builder. The URL is the `*.fly.dev` one in the
    output, and the image (`registry.fly.io/<app>:deployment-…`) is recorded **(verify the output on a live deploy)**;
  - rollback: `fly deploy --image <previous image> --remote-only --yes`, which needs the image the app recorded.
- A rollback that needs a recorded deploy and has none is refused, with "roll back in the provider's console", and
  the Deploy page doesn't offer it.
- Docker → registry is its own step: it has no URL to smoke-test and needs the registry the user names.

**As built (step 4b), Docker → registry** (flags checked against docker buildx 0.30.1):
- detect: a `Dockerfile`, and the image named on the Deploy page (`ghcr.io/you/app`: lowercase, with its registry or
  namespace, no tag), saved in `.agentchainer/docker.json`. That file isn't ignored, so a team can commit it. The
  image is the name typed to confirm a deploy;
- ready: `docker info` answers (the daemon runs). The registry login stays with `docker login`; the app never reads
  Docker's config, and the push itself says when the login is missing;
- **production only**: `docker buildx build --push --tag <image>:<12 characters of the commit> --tag <image>:latest
  --label org.opencontainers.image.revision=<commit> .`. There's no URL, so no smoke test; the record keeps the
  pushed tag;
- rollback: `docker buildx imagetools create --tag <image>:latest <image>:<previous tag>`, which moves `latest` in
  the registry without building. It needs the tag the app recorded;
- a production deploy's message is now the commit's subject (Firebase's `--message`).

## 5. Environments (M6-02, owner decision 2)

- **Preview and production** are labelled by the adapter, never guessed from a branch name.
- **Production always needs a person:**
  - the dialog shows the command, the provider's project and the branch and commit;
  - the person types the project's name to enable the button, like GitHub's "delete repository";
  - it is never automatic, never from the agent (the guard keeps blocking agents), and never part of a task's run.
- A production deploy starts from a clean tree, on the branch the dialog shows, at its current commit.
- **Credentials stay in the provider's CLI** (ADR-0002). The app only runs `whoami`-style checks, and drops their
  output beyond the exit code.
- **As built (step 3):** Workspace settings → Deploy. The project's name is `projectName` in `.vercel/project.json` or
  `name` in the wrangler config, else the workspace folder's name. Production runs in the workspace folder, not a
  task's worktree, and needs a branch (not a detached HEAD) and a clean tree; the app's own `.agentchainer/` doesn't
  count. Cloudflare production is `wrangler deploy`, which works whether or not a preview was made. The sidecar checks
  the typed name and that `HEAD` is still the plan's commit.

## 6. Smoke test and rollback (M6-03)

- **Smoke:**
  - when the project has `scripts/smoke.*` (found by `SMOKE_SCRIPT`, `gates.ts:24`), it runs with
    `SMOKE_URL=<deployment URL>` in its environment. `runGuarded` already takes `env` (`verify.ts:86`);
  - without a script, a built-in check sends `GET <url>` and expects a 2xx within 30 s (§15).
- **The result** goes on the deploy record, on the task, and in the evidence report.
- **Roll back:**
  - one click, with a confirmation (and the typed name for production);
  - it calls the adapter's rollback to the previous deployment, which was recorded when this one was made;
  - the rollback is recorded too, and the smoke test runs again on the restored deployment.
- **As built (step 3):** only the live production deploy (the newest one that worked) has Roll back; a preview has
  none, since it takes no traffic. It goes back to the recorded previous deploy, or, without one, to the provider's own
  previous (`vercel rollback --yes`, `wrangler rollback --yes`). The rollback record becomes the live one, so rolling
  it back goes forward again. The smoke test runs on the Worker's URL, or on the previous Vercel deployment's URL.

## 7. Records

Each deploy has a record in `.agentchainer/deploys/<id>.json`, kept out of git like the backups:
- adapter, environment, branch and commit;
- URL and the provider's deployment or version id;
- the previous one, which is what rollback goes back to;
- the smoke result;
- who started it (always a person) and when, and the rollback that undid it, if any.

The Deploy page lists them, and a task shows its preview deploys.

## 8. The guard

- The agent rules stay as they are.
- The app's own deploy commands run outside agent sessions, the way the gates do, so the guard doesn't apply to them.
- The message drops "arrives in M6" and points to the Deploy page instead.

## 9. The workflow canvas (M6-04, owner decision 3)

- **A project's own workflows:**
  - `.agentchainer/workflows/<tier>.yaml` (and `xl.yaml`) in the repository, shared through git;
  - loaded over the shipped library only when valid against `WorkflowSchema` / `XlWorkflowSchema` and the same
    cross-checks as `buildLibrary` (`library.ts:88-117,169`);
  - an invalid file isn't used: the shipped workflow runs, and the page says why.
- **The editor:**
  - React Flow, with M4's dagre layout made generic over node kinds (`graph/layout.ts` is tied to the agent graph
    today);
  - nodes are steps (agent, gates, parallel group); edges are the order, plus `fix.step` back-edges;
  - a side form edits a step's fields: role, access, inputs, output, limits and fix;
  - validation runs as you edit, with the schema's own messages.
- **YAML both ways:** graph ⇄ YAML through the `yaml` Document API, so comments survive where they can, plus Import,
  Export and **Reset to the app's default**.
- **Which workflow ran:** a run records whether it used the shipped workflow or the project's, with the file's hash,
  and the evidence names it.

## 10. UI

- **Task page:** a Deploy card under the result card, for previews.
- **Workspace:** a Deploy page with the adapters found, production, the history and Roll back.
- **Workspace settings:** a Workflows section, which holds the canvas.
- Light and dark from the existing tokens; every action is reachable with the keyboard (X-12).

## 11. Security and privacy

- **THREAT_MODEL**, a new threat: deploys.
  - Risks: a wrong target, production by mistake, a smoke script from the repository, and provider CLIs acting with
    the user's rights.
  - Mitigations: §5's confirmation; previews only from a task; the app's fixed commands; the guard for agents; smoke
    scripts run under the workspace guard like the gates.
- **PRIVACY**: deploys reach the provider through its CLI, and the smoke test reaches the deployment URL, only from the
  user's click.
- **A project workflow file is repository content** (T-03). It is validated, and can't grant more than the schema
  allows: the shipped roles, read or write access, and capped limits.

## 12. Testing

- **Fake CLIs:** functions in tests, as with `gh`, for detection, plans, output parsing, rollback and the smoke test.
- **Windows shims:** resolving a `.cmd` shim, and refusing to run one through a shell.
- **Recorded output:** each adapter's real CLI output, saved as samples for the parsing tests.
- **Canvas:** graph ⇄ YAML round trips, and invalid files falling back to the shipped workflow.
- **E1:** the owner's Vercel and Cloudflare accounts on a small test app, either a static page added to
  `agentchainer-e2e` or a new throwaway repository. For each: a preview deploy, the smoke test, and a rollback.

## 13. Delivery

One PR per step, each merged before the next starts:

1. **The adapter interface:** detection, the CLI wrapper with shim resolution, and Vercel preview + smoke + rollback.
2. **Cloudflare (Workers)** → **E1**.
3. **Production** with the typed confirmation; the Deploy page and the history.
4. **Fly.io, Docker and Firebase.**
5. **A project's own workflows:** loading and validation.
6. **The canvas editor** and the YAML round trip.

## 14. Alternatives considered

| Option | Why not |
|---|---|
| Provider APIs with tokens the app stores | ADR-0002: credentials stay in the provider's CLI |
| Letting the agent deploy | R-09: no automatic deploys; the guard keeps blocking it |
| Editing the shipped workflows | The owner chose a project copy (§15); the app's defaults stay intact |
| The canvas first | The owner chose deploy first (§15) |
| A confirmation dialog only, for production | The owner chose the typed name (§15) |

## 15. Decisions

**Decided** by the owner, 2026-11-01:
1. **The first adapters:** Vercel and Cloudflare (wrangler); Fly.io, Docker and Firebase later in M6.
2. **Production:** a confirmation where the person types the project's name; never automatic, never from the agent.
3. **The canvas** edits a project copy, `.agentchainer/workflows/<tier>.yaml`, validated before use; the shipped
   workflows stay the default.
4. **Order:** deploy first (M6-01…03 and E1), then the canvas (M6-04).

**Still open:**
- how Cloudflare Workers and Pages are told apart from the config;
- the built-in smoke test's success criteria: 2xx within 30 s, or a body check too;
- whether production may start only from the default branch.
