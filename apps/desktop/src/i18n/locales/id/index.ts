import app from "./app.json" with { type: "json" };
import common from "./common.json" with { type: "json" };
import graph from "./graph.json" with { type: "json" };
import home from "./home.json" with { type: "json" };
import menu from "./menu.json" with { type: "json" };
import panel from "./panel.json" with { type: "json" };
import session from "./session.json" with { type: "json" };
import setup from "./setup.json" with { type: "json" };
import shell from "./shell.json" with { type: "json" };
import tasks from "./tasks.json" with { type: "json" };
import workflows from "./workflows.json" with { type: "json" };

/**
 * Bahasa Indonesia (X-13), in its own chunk: loaded only when chosen in Settings. `i18n/catalog.test.ts` checks it has
 * every English key, with the same values and tags. Style and terms: docs/guides/TRANSLATING.md.
 */
export const CATALOGS = { common, menu, app, session, panel, shell, home, graph, tasks, setup, workflows };

const indonesian: Record<string, string> = Object.assign({}, ...Object.values(CATALOGS));
export default indonesian;
