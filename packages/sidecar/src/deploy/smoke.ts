import type { MessageRef } from "@agentchainer/protocol";
import { runGuarded } from "../bootstrap/verify.ts";
import { smokeCommand } from "../tasks/gates.ts";
import { result } from "../tasks/result.ts";

/** `detail` in English for records and evidence, `detailRef` for the app to show in its language (X-15). */
export type Smoke = { ok: boolean; how: "script" | "http"; detail: string; detailRef: MessageRef };

const said = (r: { text: string; ref: MessageRef }) => ({ detail: r.text, detailRef: r.ref });

/**
 * The smoke test after a deploy (M6-03, design §6): the project's `scripts/smoke.*` with `SMOKE_URL` set to the
 * deployment, under the workspace guard like the gates; without one, a GET of the URL that must answer 2xx within
 * 30 s.
 */
export async function runSmoke(code: string, url: string, fetchImpl: typeof fetch = fetch): Promise<Smoke> {
  const command = smokeCommand(code);
  if (command) {
    const r = await runGuarded(code, command, code, 300_000, { SMOKE_URL: url });
    const tail = r.tail.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    return {
      ok: r.exitCode === 0 && !r.timedOut,
      how: "script",
      ...said(
        r.timedOut
          ? result("deploy.smoke.timedOut", { command })
          : tail
            ? result("deploy.smoke.exitedWithOutput", { command, code: String(r.exitCode), tail })
            : result("deploy.smoke.exited", { command, code: String(r.exitCode) }),
      ),
    };
  }
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(30_000) });
    return { ok: res.ok, how: "http", ...said(result("deploy.smoke.answered", { url, status: res.status })) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, how: "http", ...said(result("deploy.smoke.failed", { url, error })) };
  }
}
