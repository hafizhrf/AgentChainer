# ADR-0014: The app being built is previewed in a sandboxed frame, local addresses only

- **Status:** Accepted
- **Date:** 2026-11-11
- **Deciders:** hafizhrf
- **Related:** UX-22, CP-12, THREAT_MODEL T-21

## Context

The owner asked for the page a chat or task starts on `localhost` (a dev server) to show in the right sidebar, next to
the chat. That puts a page the app didn't write inside the app's window. The window's own page can reach the Tauri
core: settings, the sidecar (`sidecar_send`), the terminal, opening files. The preview's page must reach none of it.
It's the project being worked on, which an agent may have written or pulled in.

We checked, in a debug build on Windows (2026-11-11), what a page in an `<iframe>` of the app's window can reach. The
probe page was served from `http://127.0.0.1:5199` and `http://localhost:5199`, with and without a sandbox attribute:

- Tauri injects its `__TAURI_INTERNALS__` into the frame too.
- **Every call through it was refused:** app commands (`settings_get`, `sidecar_send`) as "not allowed", and plugins
  (`app.version`, `opener.open_url`) with "allowed on: [windows: "main", URL: local]". The capabilities only apply to the
  app's own origin, and the frame's origin isn't it.
- A raw `fetch` to the IPC endpoint is refused for want of the invoke key.
- The parent document is out of reach (`SecurityError`).
- Nothing in the app listens for `message` events, and the isolation pattern isn't in use.

## Decision

The preview is an `<iframe>` in the right panel's **Preview** tab, for this machine's addresses only:

- **Which addresses:** `localhost`, `127.0.0.1` and `[::1]` (`0.0.0.0` is opened as localhost), over http or https.
  Both the UI (`localUrl`) and the CSP (`frame-src http://localhost:* http://127.0.0.1:* http://[::1]:*`) refuse the
  rest. Remote pages open in the browser.
- **The sandbox:** `allow-scripts allow-same-origin allow-forms allow-modals`. There's no top navigation, popups or
  downloads, so the page can't navigate the app away or open windows of its own.
- **No IPC:** the app's capabilities stay scoped to its own origin (`URL: local`). No capability may list a `remote`
  URL that covers local ports.
- **Is it up:** a sidecar method, `preview.probe`, opens a TCP connection to the address's port and sends nothing. It
  refuses any host but the local ones, so the page's address can't make the app connect elsewhere.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| A second Tauri webview in the window (multiwebview) | Its own process context; devtools per webview | Behind Tauri's `unstable` feature; it's positioned by hand over the React layout and moves on every resize | More moving parts for the same isolation the capabilities already give |
| A separate preview window | Simple isolation | Not "in the sidebar", which is what was asked | Doesn't meet the request |
| Open in the browser only | No new surface | The request was to see it next to the chat | Kept as the pane's "Open in browser" button |

## Consequences

- **Positive:** a dev server's page shows next to the chat with no new window or Tauri feature. Its isolation rests on
  two independent things, the capabilities' origin scope and the CSP, and we've checked it.
- **Negative:** the injected `__TAURI_INTERNALS__` object is visible to the page, even though every call is refused. A
  future capability with `remote` URLs, or a `message` listener in the app, would need this ADR reread. The probe
  polls every 3 s while the tab shows.
- **Revisit when:** Tauri changes how capabilities treat subframes, CP-12 needs devtools for the preview (a separate
  webview may then be worth it), or a capability gains `remote` URLs.

## References

- [Tauri v2 capabilities](https://v2.tauri.app/security/capabilities/): `remote` URLs and the local-origin default
  **(verify)** against the version in `Cargo.lock` when Tauri is upgraded.
- The probe page and its results: the UX-22 PR.
