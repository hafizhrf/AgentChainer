import { currentLanguage } from "@agentchainer/protocol";
import type { Item, Profile } from "./schema.ts";

/**
 * The catalog's prose in the app's language (X-13): an item's or a profile's translation from its YAML when the app
 * isn't in English, its English otherwise. The English is the text that counts (CATALOG §4); this is what's shown.
 */
const translation = <T>(i18n: { id: T } | undefined): T | undefined =>
  currentLanguage() === "id" ? i18n?.id : undefined;

export function itemText(item: Item) {
  const tr = translation(item.i18n);
  return {
    name: tr?.name ?? item.name,
    summary: tr?.summary ?? item.summary,
    why: tr?.why ?? item.why,
    permissions: tr?.permissions ?? item.permissions,
    notes: tr?.notes ?? item.notes,
    /** The hint for a required tool. */
    hint: (tool: string) => tr?.hints?.[tool] ?? item.requires.find((r) => r.tool === tool)?.hint ?? "",
  };
}

export function profileText(profile: Profile) {
  const tr = translation(profile.i18n);
  return { name: tr?.name ?? profile.name, description: tr?.description ?? profile.description };
}

/** A workflow's description and step labels in the app's language: a project's file may carry no translation. */
export function workflowText(w: {
  description: string;
  i18n?: { id: { description: string; labels: Record<string, string> } } | undefined;
}) {
  const tr = translation(w.i18n);
  return {
    description: tr?.description ?? w.description,
    label: (id: string, english: string) => tr?.labels[id] ?? english,
  };
}
