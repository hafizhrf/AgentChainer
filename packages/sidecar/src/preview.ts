import { connect } from "node:net";
import { RpcErrorCode } from "@agentchainer/protocol";
import { t } from "./i18n/index.ts";
import { RpcFailure } from "./rpc.ts";

/**
 * Whether a local server still answers, for the app's preview (UX-22): a TCP connection to its port, nothing sent.
 * Only this machine's addresses are tried; anything else is refused before a connection is made.
 */

const HOSTS: Record<string, string> = {
  localhost: "localhost",
  "127.0.0.1": "127.0.0.1",
  "[::1]": "::1",
  "0.0.0.0": "127.0.0.1",
};

const TIMEOUT_MS = 1500;

/** The host and port to try for `raw`, or a refusal when it isn't a local http(s) address. */
export function probeTarget(raw: string): { host: string; port: number } {
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    // refused below
  }
  const host = url ? HOSTS[url.hostname] : undefined;
  if (!url || !host || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new RpcFailure(RpcErrorCode.invalidParams, t("rpc.preview.notLocal", { url: raw }));
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { host, port };
}

export function probe(raw: string, timeoutMs = TIMEOUT_MS): Promise<{ up: boolean }> {
  const { host, port } = probeTarget(raw);
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve({ up });
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
