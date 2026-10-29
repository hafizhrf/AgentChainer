import { useCallback, useState } from "react";
import type { LayoutStorage } from "react-resizable-panels";

/**
 * Panel sizes live in localStorage: a per-device convenience. Storage can be missing or throw (private mode, cleared
 * site data), and then the panels simply start at their default sizes.
 */
export const layoutStorage: LayoutStorage = {
  getItem: (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Not saved; the default layout comes back next time.
    }
  },
};

/** A remembered on/off UI preference (panel open or closed), with the same fallbacks as `layoutStorage`. */
export function usePersistentFlag(
  key: string,
  initial: boolean,
): [boolean, (update: (value: boolean) => boolean) => void] {
  const [value, setValue] = useState(() => {
    const saved = layoutStorage.getItem(key);
    return saved === null ? initial : saved === "1";
  });
  const update = useCallback(
    (fn: (value: boolean) => boolean) =>
      setValue((prev) => {
        const next = fn(prev);
        layoutStorage.setItem(key, next ? "1" : "0");
        return next;
      }),
    [key],
  );
  return [value, update];
}
