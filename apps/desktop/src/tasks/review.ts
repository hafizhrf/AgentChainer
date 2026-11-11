import { type Review, ReviewSchema } from "@agentchainer/protocol";
import type { Item } from "../transcript.ts";

/** The tool through which Claude hands in a step's structured output (the SDK's own). */
const STRUCTURED_OUTPUT = "StructuredOutput";

/** A review in an answer's text: the JSON object in it, as the sidecar's `parseReview` reads it. */
function fromText(text: string): Review | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = ReviewSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The review a reviewer's transcript ends with (M9-05): Claude hands it in through `StructuredOutput`, Codex and agy
 * as JSON in their last answer. Returned with the item that holds it, which the step shows as a summary instead of
 * raw JSON. Null when the last answer isn't a review.
 */
export function reviewIn(items: readonly Item[]): { review: Review; item: Item } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "tool" && item.name === STRUCTURED_OUTPUT) {
      const parsed = ReviewSchema.safeParse(item.input);
      return parsed.success ? { review: parsed.data, item } : null;
    }
    if (item?.kind === "assistant") {
      const review = fromText(item.text);
      return review ? { review, item } : null;
    }
  }
  return null;
}
