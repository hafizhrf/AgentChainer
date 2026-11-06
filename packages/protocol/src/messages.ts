import { catalog } from "./i18n.ts";
import en from "./locales/en.json" with { type: "json" };
import id from "./locales/id.json" with { type: "json" };

/** The protocol's own text (X-13): approval reasons, agent and folder problems, cadences. Both languages are small. */
export const { t } = catalog(en, { id: () => id });
