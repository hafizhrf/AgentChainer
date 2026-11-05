import { invoke } from "@tauri-apps/api/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { setLocale, setPseudo } from "./i18n/index.ts";
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

// English only so far (X-13). A debug build may render the pseudo-locale instead, before anything is drawn.
setLocale("en");
invoke<boolean>("pseudo_locale")
  .catch(() => false)
  .then((pseudo) => {
    setPseudo(pseudo);
    createRoot(document.getElementById("root") as HTMLElement).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
