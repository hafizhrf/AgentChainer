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

/**
 * A remembered UI preference (a panel open or closed, the hidden panel tabs), with the same fallbacks as
 * `layoutStorage`. A null key keeps the value for this mount only. `parse` and `serialize` must be stable (module-level).
 */
export function usePersistentValue<T>(
  key: string | null,
  initial: T,
  parse: (raw: string) => T,
  serialize: (value: T) => string,
): [T, (update: (value: T) => T) => void] {
  const [value, setValue] = useState(() => {
    const saved = key === null ? null : layoutStorage.getItem(key);
    return saved === null ? initial : parse(saved);
  });
  const update = useCallback(
    (fn: (value: T) => T) =>
      setValue((prev) => {
        const next = fn(prev);
        if (key !== null) layoutStorage.setItem(key, serialize(next));
        return next;
      }),
    [key, serialize],
  );
  return [value, update];
}

const parseFlag = (raw: string) => raw === "1";
const serializeFlag = (value: boolean) => (value ? "1" : "0");

/** A remembered on/off UI preference, such as a panel being open. */
export function usePersistentFlag(
  key: string | null,
  initial: boolean,
): [boolean, (update: (value: boolean) => boolean) => void] {
  return usePersistentValue(key, initial, parseFlag, serializeFlag);
}
