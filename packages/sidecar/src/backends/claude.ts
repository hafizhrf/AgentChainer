import type { AgentSdkModule } from "../sdk-loader.ts";
import { Session } from "../session.ts";
import type { StepBackend } from "./types.ts";

/** Where Claude step sessions are registered, so `permission.respond` and `session.interrupt` reach them. */
export type ClaudeHost = {
  sdk: AgentSdkModule;
  claudePath: string;
  register(session: Session): void;
  unregister(sessionId: string): void;
};

/** Task steps on the user's own Claude CLI, through the Agent SDK: the default backend (ADR-0012). */
export function claudeBackend(host: ClaudeHost): StepBackend {
  return (options, callbacks) => {
    const session: Session = new Session(
      host.sdk,
      { ...options, claudePath: host.claudePath },
      {
        ...callbacks,
        onEnd: () => {
          host.unregister(session.id);
          callbacks.onEnd();
        },
      },
    );
    host.register(session);
    return session;
  };
}
