import { asTheme, resolveTheme, type ThemeSetting } from "./theme.ts";

/** Applies the theme setting to the page, and tells components that paint their own colors (Monaco, xterm). */

const media = () => window.matchMedia("(prefers-color-scheme: dark)");
const CHANGED = "agentchainer:theme";

/**
 * Colors switch at once: without this, buttons fade between themes, and in a window that isn't focused WebKit can
 * leave that fade half done.
 */
function withoutTransitions(change: () => void) {
  const root = document.documentElement;
  root.classList.add("theme-switching");
  change();
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
}

export function applyTheme(setting: ThemeSetting): void {
  withoutTransitions(() => {
    document.documentElement.dataset.theme = setting;
  });
  window.dispatchEvent(new Event(CHANGED));
}

// The OS switching between light and dark changes the tokens through CSS alone; skip the fades there too.
media().addEventListener("change", () => withoutTransitions(() => undefined));

export function isDark(): boolean {
  return resolveTheme(asTheme(document.documentElement.dataset.theme), media().matches) === "dark";
}

/** Calls `onChange` whenever the shown theme may have changed (the setting or the OS); returns the unsubscribe. */
export function onThemeChange(onChange: () => void): () => void {
  const query = media();
  query.addEventListener("change", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    query.removeEventListener("change", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}
