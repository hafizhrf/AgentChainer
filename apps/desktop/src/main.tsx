import { invoke } from "@tauri-apps/api/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { asLanguage, setLocale, setPseudo } from "./i18n/index.ts";
import { loadSettings } from "./settings.ts";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/session.css";
import "./styles/tree.css";
import "./styles/setup.css";
import "./styles/features.css";
import "./styles/tasks.css";
import "./styles/graph.css";

// The language comes from the saved settings (X-13), before anything is drawn: a change in Settings restarts the app.
// A debug build may render the pseudo-locale on top.
async function start() {
  const settings = await loadSettings().catch(() => null);
  await setLocale(asLanguage(settings?.language));
  setPseudo(await invoke<boolean>("pseudo_locale").catch(() => false));
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
