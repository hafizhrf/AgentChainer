# Set up GitHub for AgentChainer's pull requests

AgentChainer opens pull requests through the official **GitHub CLI** (`gh`) installed on your computer.
**You sign in to GitHub yourself, in your own terminal.** AgentChainer never asks for your password or token, never
reads `gh`'s stored credentials, and never stores anything about your account. It only checks whether `gh` is
installed and signed in for the host of your repository's `origin` remote.

You need this only for **Create PR** on a task. Everything else in AgentChainer works without it.

Commands come from the GitHub CLI's own documentation ([installation](https://github.com/cli/cli#installation),
[`gh auth login`](https://cli.github.com/manual/gh_auth_login)) **(verify)** as of Nov 2026.

---

## Step 1 — Install `gh`

Open a terminal:

- **macOS:** press `Cmd + Space`, type "Terminal", press Enter.
- **Windows:** press `Start`, type "PowerShell", press Enter.
- **Linux:** open your Terminal app (often `Ctrl + Alt + T`).

Then run the command for your system.

**macOS (Homebrew)**

```bash
brew install gh
```

**Windows**

```powershell
winget install --id GitHub.cli
```

**Ubuntu / Debian:** follow the "Debian, Ubuntu Linux" steps in the
[GitHub CLI's Linux guide](https://github.com/cli/cli/blob/trunk/docs/install_linux.md), which add GitHub's package
repository and then run `sudo apt install gh`.

Close and reopen the terminal, then check it:

```bash
gh --version
```

## Step 2 — Sign in

```bash
gh auth login
```

Answer its questions: `GitHub.com` (or your company's GitHub Enterprise host), your preferred protocol, and sign in
with your browser. For a GitHub Enterprise host, pass it:

```bash
gh auth login --hostname github.example.com
```

Check it:

```bash
gh auth status
```

## Step 3 — Check in AgentChainer

Open the task, click **Create PR…**, then **Check again**. The dialog shows the branch, the base and the body that
will be sent.

## What AgentChainer does with `gh`

Only these, always from your click:

- `git push -u origin agentchainer/<task id>`: your own git credentials; never forced;
- `gh pr view` and `gh pr create --draft`: the PR's title and body are shown before they're sent.

It runs `gh` with arguments, never through a shell, and turns `gh`'s prompts off. It never merges on its own.

## If something goes wrong

| What you see | What to do |
|---|---|
| "The GitHub CLI (gh) isn't installed" | Do Step 1, then reopen the dialog. If `gh` is installed somewhere unusual, put it on your PATH. |
| "gh isn't signed in to …" | Run `gh auth login --hostname <that host>` in a terminal (Step 2). |
| "The repository has no origin remote on GitHub" | Add one: `git remote add origin https://github.com/<owner>/<name>.git`. |
| "git push failed" | Push once by hand (`git push`) to check your git credentials for that remote. |
| "gitleaks flagged possible secrets in …" | Remove the secrets from those files, run the task's fix again or edit by hand, then retry. |
