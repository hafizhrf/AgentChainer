import { asTheme, resolveTheme, type ThemeSetting } from "./theme.ts";

/** Applies the theme setting to the page, and tells components that paint their own colors (Monaco, xterm). */

const media = () => window.matchMedia("(prefers-color-scheme: dark)");
const CHANGED = "agentchainer:theme";

export function applyTheme(setting: ThemeSetting): void {
  document.documentElement.dataset.theme = setting;
  window.dispatchEvent(new Event(CHANGED));
}

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
