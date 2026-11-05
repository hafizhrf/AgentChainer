import { Fragment, type ReactNode } from "react";
import { type MessageKey, type Params, richParts } from "./index.ts";

/**
 * A message with markup: `tags` renders each tagged part, e.g.
 * `<Rich k="…" tags={{ kbd: (s) => <kbd>{s}</kbd> }} />` for "Press <kbd>⌘K</kbd> to search".
 */
export function Rich({
  k,
  params,
  tags,
}: {
  k: MessageKey;
  params?: Params;
  tags: Record<string, (text: string) => ReactNode>;
}) {
  return (
    <>
      {richParts(k, params).map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one message never reorder.
        <Fragment key={i}>{part.tag ? (tags[part.tag]?.(part.text) ?? part.text) : part.text}</Fragment>
      ))}
    </>
  );
}
