import type { DeployRecord } from "@agentchainer/protocol";
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

/** Why a deploy failed, in the app's language when the sidecar wrote it (X-15); the CLI's own output as it is. */
export const deployError = (d: DeployRecord) => localized(d.error, d.errorRef);

/** What a deploy's smoke test found, in the app's language when the record has a ref (X-15). */
export const smokeDetail = (d: DeployRecord) => (d.smoke ? localized(d.smoke.detail, d.smoke.detailRef) : undefined);
