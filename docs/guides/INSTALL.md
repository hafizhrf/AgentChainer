# Install AgentChainer

> **Draft for v0.1.** The v0.1 installers are **not code-signed**, so macOS and Windows warn you the first time you
> open the app. The steps below get past that safely: check the download against `SHA256SUMS` first, then open it.
> Operating-system wording changes between versions; anything marked **(verify)** hasn't been checked on every
> version yet.

You also need the Claude Code CLI, installed and signed in by you. See [AUTH_SETUP.md](AUTH_SETUP.md).

## 1. Download

Get the files from the [latest release](https://github.com/hafizhrf/AgentChainer/releases/latest):

| System | File |
|---|---|
| macOS, Apple silicon (M1 and later) | `AgentChainer_<version>_aarch64.dmg` |
| macOS, Intel | `AgentChainer_<version>_x64.dmg` |
| Windows 10 and 11 (64-bit) | `AgentChainer_<version>_x64-setup.exe`, which installs for you only. Or `AgentChainer_<version>_x64_en-US.msi`, which installs for every user and needs admin rights. |
| Ubuntu, Debian | `AgentChainer_<version>_amd64.deb` |
| Fedora, openSUSE | `AgentChainer-<version>-1.x86_64.rpm` |
| Other Linux | `AgentChainer_<version>_amd64.AppImage` |

Also download `SHA256SUMS` from the same release.

## 2. Check the download

Run this in the folder that holds both files. Every line must say `OK`.

- **macOS:** `shasum -a 256 -c SHA256SUMS --ignore-missing`
- **Linux:** `sha256sum -c SHA256SUMS --ignore-missing`
- **Windows (PowerShell):** run `Get-FileHash .\AgentChainer_<version>_x64-setup.exe`, then compare the hash with the
  file's line in `SHA256SUMS`. Case doesn't matter.

If a check fails, don't open the file. Download it again. If it still fails,
[report it privately](../../SECURITY.md).

## 3. Install

### macOS

1. Open the `.dmg`, and drag **AgentChainer** to **Applications**.
2. Open AgentChainer. macOS says it can't check the app for malicious software. Click **Done**, not Move to Trash.
3. Open **System Settings → Privacy & Security**, scroll to Security, and click **Open Anyway** next to AgentChainer.
   Confirm with your password. **(verify)**

If macOS instead says that AgentChainer **"is damaged and can't be opened"**, the download is fine: that's how
recent macOS versions treat unsigned apps from the internet. **(verify)** After the checksum passed, run this in
Terminal and open the app again:

```sh
xattr -dr com.apple.quarantine /Applications/AgentChainer.app
```

### Windows

1. Run the installer. If **"Windows protected your PC"** appears (SmartScreen), click **More info**, then
   **Run anyway**.
2. Follow the installer.

The app needs Microsoft Edge WebView2, which Windows 10 and 11 normally include. If it's missing, the installer
downloads it. **(verify)**

### Linux

- **.deb:** `sudo apt install ./AgentChainer_<version>_amd64.deb`
- **.rpm:** `sudo dnf install ./AgentChainer-<version>-1.x86_64.rpm`
- **AppImage:** `chmod +x AgentChainer_<version>_amd64.AppImage`, then run it. Some distributions need FUSE 2 first,
  for example `sudo apt install libfuse2`. **(verify)**

The packages pull in WebKitGTK 4.1. The AppImage brings its own.

## 4. First start

On first start, AgentChainer downloads the pinned Claude Agent SDK from npm and checks its hash, so it needs
internet access once. Then it checks that `claude` is installed and signed in, and walks you through it if not.

## Updates

Use **Help → Check for Updates…** or **Settings → About**. The app never checks by itself. It shows the new version and
its notes, and installs only when you click **Install and restart**. Every update is signed, and the app refuses one
whose signature doesn't match. On Linux, a `.deb` or `.rpm` update asks for your password.

## Uninstall

- **macOS:** move AgentChainer from Applications to the Trash.
- **Windows:** Settings → Apps → AgentChainer → Uninstall.
- **Linux:** `sudo apt remove agent-chainer` or `sudo dnf remove agent-chainer` **(verify the .rpm name)**, or delete
  the AppImage.

Settings, logs and downloaded tools stay behind. [PRIVACY.md](../PRIVACY.md#what-stays-on-your-machine) lists their
folders.
