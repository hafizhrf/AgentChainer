import { type MessageRef, type ResultKey, resultEnglish, resultRef } from "@agentchainer/protocol";

/**
 * A task result (X-13 part 2b): its English `text`, which records, pull requests, evidence and Claude get, and its
 * `ref`, which the app shows in its own language. Both come from one template, so they can't drift apart.
 */
export function result(key: ResultKey, params?: Record<string, string | number | MessageRef>) {
  const ref = resultRef(key, params);
  return { text: resultEnglish(ref), ref };
}
