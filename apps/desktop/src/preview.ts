import type { Item } from "./transcript.ts";

/**
 * Local addresses for the preview (UX-22): a dev server's "Local: http://localhost:5173" in a command's or a
 * background task's output. Only the machine's own addresses: a remote page never opens inside the app.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/** `raw` as a preview address when it's an http(s) URL on this machine, else null. `0.0.0.0` reads as localhost. */
export function localUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!LOCAL_HOSTS.has(url.hostname) || url.username || url.password) return null;
  if (url.hostname === "0.0.0.0") url.hostname = "localhost";
  return url.href;
}

// Terminal colours and styles, which dev servers print around their address.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what's being matched.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const FOUND = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:\/[^\s"'`<>)\]]*)?/gi;

/** The local addresses in `text`, in order, each once. */
export function localUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.replace(ANSI, "").matchAll(FOUND)) {
    const url = localUrl(m[0].replace(/[.,;:!?]+$/, ""));
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/** The local addresses the chat's commands and background tasks printed, the latest first. */
export function previewUrls(items: readonly Item[]): string[] {
  const out: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "tool" || !item.output) continue;
    for (const url of localUrls(item.output).reverse()) if (!out.includes(url)) out.push(url);
  }
  return out;
}
