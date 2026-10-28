import { createInterface } from "node:readline";
import type { Notifications, RpcFrame, RpcRequest } from "@agentchainer/protocol";

export type Handler = (params: Record<string, unknown>) => unknown;

/** Thrown by handlers to return a JSON-RPC error with a specific code. */
export class RpcFailure extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// stdout carries protocol frames only (ADR-0003). Everything else goes to stderr via log().
function write(frame: RpcFrame): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function notify<N extends keyof Notifications>(method: N, params: Notifications[N]): void {
  write({ jsonrpc: "2.0", method, params });
}

/**
 * Reads NDJSON JSON-RPC requests from stdin and dispatches them. When stdin closes (host gone),
 * finishes in-flight requests, runs `onClose`, flushes stdout and exits.
 */
export function serve(handlers: Record<string, Handler>, onClose?: () => void): void {
  const inflight = new Set<Promise<void>>();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const done: Promise<void> = dispatch(line, handlers).finally(() => inflight.delete(done));
    inflight.add(done);
  });
  rl.on("close", () => {
    void Promise.allSettled(inflight).then(() => {
      onClose?.();
      process.stdout.write("", () => process.exit(0));
    });
  });
}

async function dispatch(line: string, handlers: Record<string, Handler>): Promise<void> {
  let req: RpcRequest;
  try {
    req = JSON.parse(line) as RpcRequest;
  } catch {
    log(`rpc: ignoring non-JSON line`);
    return;
  }
  const handler = handlers[req.method];
  if (!handler) {
    write({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Unknown method ${req.method}` } });
    return;
  }
  try {
    const params = (req.params ?? {}) as Record<string, unknown>;
    write({ jsonrpc: "2.0", id: req.id, result: await handler(params) });
  } catch (err) {
    const code = err instanceof RpcFailure ? err.code : -32000;
    write({ jsonrpc: "2.0", id: req.id, error: { code, message: err instanceof Error ? err.message : String(err) } });
  }
}

export function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "") throw new RpcFailure(-32602, `Missing string param "${key}"`);
  return value;
}
