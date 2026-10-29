/** Light / Dark / System theme (UX-02): `data-theme` on <html> drives the tokens in styles/tokens.css. */
export type ThemeSetting = "system" | "light" | "dark";

export const asTheme = (value: string | null | undefined): ThemeSetting =>
  value === "light" || value === "dark" ? value : "system";

/** The theme actually shown, for components that paint their own colors (Monaco, xterm). */
export function resolveTheme(setting: ThemeSetting, prefersDark: boolean): "light" | "dark" {
  return setting === "system" ? (prefersDark ? "dark" : "light") : setting;
}
