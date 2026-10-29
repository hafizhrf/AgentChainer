import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createClient, type SidecarExit } from "./rpc-client.ts";

export { isRpcError, type Notification, SidecarError, type SidecarExit } from "./rpc-client.ts";

/** The app's sidecar client: frames travel through the Rust core as Tauri events and commands (ADR-0003). */
const client = createClient({
  listen: async ({ frame, exit, ready }) => {
    await Promise.all([
      listen<string>("sidecar://frame", (e) => frame(e.payload)),
      listen<SidecarExit>("sidecar://exit", (e) => exit(e.payload)),
      listen("sidecar://ready", () => ready()),
    ]);
  },
  send: async (frame) => {
    await invoke("sidecar_send", { frame });
  },
});

export const { connect, request, requestWithTimeout, subscribe, onExit, onReady, takeDeltaLatencies } = client;
