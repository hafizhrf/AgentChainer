import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { isDark, onThemeChange } from "./appearance.ts";

const THEMES = {
  dark: { background: "#1c201e", foreground: "#e6ebe8", cursor: "#7fb89a", selectionBackground: "#2f4a3b" },
  light: { background: "#ffffff", foreground: "#1b1f1d", cursor: "#3f6b52", selectionBackground: "#cfe3d7" },
};
const termTheme = () => (isDark() ? THEMES.dark : THEMES.light);

/**
 * Integrated terminal (M1-29): the user's own shell in the workspace folder, through a PTY in the Rust core.
 * Loaded lazily. What's typed here goes straight to the shell, not through the agent.
 */
export default function TerminalPanel({ cwd }: { cwd: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: termTheme(),
    });
    const offTheme = onThemeChange(() => {
      term.options.theme = termTheme();
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    let id: number | null = null;
    let disposed = false;
    // The shell prints its prompt before pty_open returns its id, so hold output for ids we don't know yet.
    const early = new Map<number, string[]>();
    const offData = listen<{ id: number; data: string }>("pty://data", (e) => {
      if (e.payload.id === id) term.write(e.payload.data);
      else if (id === null) early.set(e.payload.id, [...(early.get(e.payload.id) ?? []), e.payload.data]);
    });
    const offExit = listen<{ id: number }>("pty://exit", (e) => {
      if (e.payload.id === id) term.write("\r\n[shell exited — close and reopen the terminal to start a new one]\r\n");
    });
    invoke<number>("pty_open", { cwd, cols: term.cols, rows: term.rows })
      .then((opened) => {
        if (disposed) {
          void invoke("pty_close", { id: opened });
          return;
        }
        id = opened;
        for (const chunk of early.get(opened) ?? []) term.write(chunk);
        early.clear();
      })
      .catch((err: unknown) => term.write(`Couldn't start a shell: ${err}\r\n`));

    const input = term.onData((data) => {
      if (id !== null) void invoke("pty_write", { id, data });
    });
    const resize = new ResizeObserver(() => {
      if (!el.clientWidth || !el.clientHeight) return; // hidden tab
      fit.fit();
      if (id !== null) void invoke("pty_resize", { id, cols: term.cols, rows: term.rows });
    });
    resize.observe(el);

    return () => {
      disposed = true;
      offTheme();
      resize.disconnect();
      input.dispose();
      void offData.then((unlisten) => unlisten());
      void offExit.then((unlisten) => unlisten());
      if (id !== null) void invoke("pty_close", { id });
      term.dispose();
    };
  }, [cwd]);

  return <div className="terminal-host" ref={host} />;
}
