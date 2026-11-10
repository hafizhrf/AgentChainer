import { t } from "./index.ts";

/**
 * Numbers, money, dates and durations for the UI (X-13). Words and units come from the catalogs; dates and grouped
 * numbers keep the system's regional format, as they did before the catalogs. Costs are in US dollars.
 */

/** "$0.4213", "$2.00". */
export const usd = (n: number, digits = 2) => `$${n.toFixed(digits)}`;

/** An estimate: "≈$0.0421". */
export const approxUsd = (n: number, digits: number) => `≈${usd(n, digits)}`;

/** A count in the system's grouping: "12,345". */
export const count = (n: number) => n.toLocaleString();

/** "42%". */
export const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

/** Date and time in the system's regional format. */
export const dateTime = (when: Date | string | number) => new Date(when).toLocaleString();

/** Time of day in the system's regional format; `options` as for `toLocaleTimeString`. */
export const timeOfDay = (when: Date | string | number, options?: Intl.DateTimeFormatOptions) =>
  new Date(when).toLocaleTimeString([], options);

/** "12 s". */
export const seconds = (n: number | string) => t("common.format.seconds", { n });

/** "4 min". */
export const minutes = (n: number) => t("common.format.minutes", { n });

/** "2 h". */
export const hours = (n: number) => t("common.format.hours", { n });

/** "12 s" under a minute, else "3 min 4 s". */
export function minutesSeconds(totalSeconds: number): string {
  return totalSeconds < 60
    ? seconds(totalSeconds)
    : t("common.format.minutesSeconds", { m: Math.floor(totalSeconds / 60), s: totalSeconds % 60 });
}

/** "45s" under a minute, else "2m 05s": where space is short. */
export function compactDuration(totalSeconds: number): string {
  return totalSeconds < 60
    ? t("common.format.compactSeconds", { n: totalSeconds })
    : t("common.format.compactMinutesSeconds", {
        m: Math.floor(totalSeconds / 60),
        s: String(totalSeconds % 60).padStart(2, "0"),
      });
}

/** "12k" for a rounded thousand count, as in token counts. */
export const thousands = (n: number | string) => t("common.format.thousands", { n });

/** "1.5 MB". */
export const megabytes = (bytes: number) => t("common.format.megabytes", { n: (bytes / 1_000_000).toFixed(1) });

/** A file's size: "12 KB" under a megabyte, else "1.5 MB" (UX-21). */
export const fileSize = (bytes: number) =>
  bytes < 1_000_000 ? t("common.format.kilobytes", { n: Math.max(1, Math.round(bytes / 1000)) }) : megabytes(bytes);
