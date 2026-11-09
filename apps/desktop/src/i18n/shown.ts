import { type MessageRef, resultText } from "@agentchainer/protocol";

/**
 * A task result as the app shows it (X-13 part 2b): in the app's language when the sidecar stored how to translate
 * it, as written otherwise (records from before, and the workflow's own words).
 */
export function localized(text: string, ref: MessageRef | undefined): string;
export function localized(text: string | undefined, ref: MessageRef | undefined): string | undefined;
export function localized(text: string | undefined, ref: MessageRef | undefined): string | undefined {
  return ref ? resultText(ref) : text;
}
