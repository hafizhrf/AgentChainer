# Set up Claude for AgentChainer

> **Draft.** This guide describes how AgentChainer v0.1 will behave. The app shows the same steps on its onboarding
> screen. Commands come from the official Claude Code docs as of Oct 2026:
> [Setup](https://code.claude.com/docs/en/setup) · [Authentication](https://code.claude.com/docs/en/authentication).

AgentChainer runs on top of the **official Claude Code CLI** (`claude`) installed on your computer.
**You sign in to Claude yourself, in your own terminal.** AgentChainer never asks for your password, token or API key,
and never stores them. It only checks whether `claude` is installed and signed in.

You need about 5 minutes.

---

## Step 1 — Check what you need

You need **one** of these:

- A **Claude Pro, Max, Team or Enterprise** subscription. The free claude.ai plan does not include Claude Code.
- A **Claude Console** account (pay-per-use API billing).
- Access to **Amazon Bedrock**, **Google Cloud's Agent Platform (Vertex AI)** or **Microsoft Foundry** through your organization.

## Step 2 — Install the Claude Code CLI

Open a terminal:

- **macOS:** press `Cmd + Space`, type "Terminal", press Enter.
- **Windows:** press `Start`, type "PowerShell", press Enter. Your prompt starts with `PS C:\`.
- **Linux:** open your Terminal app (often `Ctrl + Alt + T`).

Then run the command for your system.

**macOS / Linux**

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://claude.ai/install.ps1 | iex
```

**Windows (Command Prompt / CMD)**

```batch
curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd
```

**Prefer a package manager?**

| System | Command | Note |
|---|---|---|
| macOS (Homebrew) | `brew install --cask claude-code` | Doesn't auto-update: run `brew upgrade claude-code` |
| Windows (WinGet) | `winget install Anthropic.ClaudeCode` | Doesn't auto-update: run `winget upgrade Anthropic.ClaudeCode` |
| Debian/Ubuntu, Fedora/RHEL, Alpine | apt / dnf / apk repositories | See [the official instructions](https://code.claude.com/docs/en/setup#install-with-linux-package-managers) |

> **Windows users:** install [Git for Windows](https://git-scm.com/downloads/win) too. Claude uses it to run shell commands.
> AgentChainer v0.1 needs Claude installed **on Windows itself**. A `claude` installed only inside WSL won't be detected yet.

**Check that it worked.** Close the terminal, open a **new** one, and run:

```bash
claude --version
```

You should see something like `2.1.xxx (Claude Code)`. If you see "command not found" or "not recognized", see
[Troubleshooting](#troubleshooting).

## Step 3 — Sign in (in your terminal)

Pick the line that matches your account and run it:

| Your account | Command |
|---|---|
| Claude Pro / Max / Team / Enterprise | `claude auth login` |
| Claude Console (API billing) | `claude auth login --console` |
| Your organization uses SSO | `claude auth login --sso` |

A browser window opens. Sign in and approve. If the browser shows a code instead of returning to the terminal, paste the
code into the terminal. When the terminal says the login succeeded, you're done.

### Alternative: environment variables (API key or cloud provider)

Use this if your organization gave you an API key or cloud credentials instead of a login.

| Provider | Variables to set |
|---|---|
| Anthropic API key | `ANTHROPIC_API_KEY=<your key>` |
| Amazon Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` + your AWS credentials ([guide](https://code.claude.com/docs/en/amazon-bedrock)) |
| Google Cloud (Vertex AI) | `CLAUDE_CODE_USE_VERTEX=1` + your GCP settings ([guide](https://code.claude.com/docs/en/google-vertex-ai)) |
| Microsoft Foundry | `CLAUDE_CODE_USE_FOUNDRY=1` + your Azure settings ([guide](https://code.claude.com/docs/en/microsoft-foundry)) |

Where to put them so AgentChainer can see them:

- **macOS:** add `export NAME=value` lines to `~/.zshrc` (or `~/.bash_profile` if you use bash). AgentChainer reads your
  login shell's environment when it starts. Restart AgentChainer after editing.
- **Linux:** add `export NAME=value` lines to `~/.profile` (or `~/.bashrc`), then log out and back in, or restart AgentChainer.
- **Windows:** search Start for "Edit environment variables for your account", add each variable, then restart AgentChainer.

> If both a login and `ANTHROPIC_API_KEY` exist, Claude uses the API key. Remove the variable if you meant to use your subscription.

## Step 4 — Verify, then go back to AgentChainer

```bash
claude auth status --text
```

It should show that you're signed in and which method is used. Now click **Re-check** in AgentChainer.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `claude: command not found` / `'claude' is not recognized` | Open a **new** terminal. If it still fails, the install folder isn't on your PATH. See [Fix your PATH](https://code.claude.com/docs/en/troubleshoot-install#command-not-found-claude-after-installation). In AgentChainer, you can also set the binary path manually in **Settings → Claude CLI path** (macOS/Linux default: `~/.local/bin/claude`; Windows: `%USERPROFILE%\.local\bin\claude.exe`). |
| AgentChainer says your Claude version is too old | Run `claude update` (Homebrew: `brew upgrade claude-code`; WinGet: `winget upgrade Anthropic.ClaudeCode`). |
| Signed in with the wrong account | `claude auth logout`, then sign in again (Step 3). |
| Login prompt keeps appearing / login expired | Run `claude auth login` again. |
| Something else is off | Run `claude doctor` and follow its suggestions. |
| PowerShell says `The token '&&' is not a valid statement separator` | You're in PowerShell, so use the PowerShell command, not the CMD one. |

## Privacy

- AgentChainer **never** sees, stores or sends your credentials. Your login stays with the official Claude CLI:
  macOS Keychain, or `~/.claude/.credentials.json` on Linux and Windows.
- AgentChainer only runs `claude --version` and `claude auth status` to check readiness, and it doesn't log their output beyond "signed in: yes/no".
- AgentChainer is an independent open-source project, **not affiliated with Anthropic**.
