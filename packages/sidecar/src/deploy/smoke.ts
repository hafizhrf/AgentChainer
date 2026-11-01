import { runGuarded } from "../bootstrap/verify.ts";
import { smokeCommand } from "../tasks/gates.ts";

export type Smoke = { ok: boolean; how: "script" | "http"; detail: string };

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
      detail: r.timedOut
        ? `\`${command}\` timed out.`
        : `\`${command}\` exited ${r.exitCode}${tail ? `: ${tail}` : ""}`,
    };
  }
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(30_000) });
    return { ok: res.ok, how: "http", detail: `GET ${url} answered ${res.status}.` };
  } catch (err) {
    return { ok: false, how: "http", detail: `GET ${url} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
