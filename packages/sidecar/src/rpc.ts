import { createInterface } from "node:readline";
import {
  describeIssues,
  isMethodName,
  type MethodName,
  type MethodParams,
  type MethodResult,
  methodSchemas,
  type Notifications,
  RpcErrorCode,
  type RpcFrame,
  type RpcRequest,
} from "@agentchainer/protocol";

/** One handler per protocol method. Params arrive validated against the method's schema (M1-02). */
export type Handlers = {
  [M in MethodName]: (params: MethodParams<M>) => MethodResult<M> | Promise<MethodResult<M>>;
};
export type Write = (frame: RpcFrame) => void;

/** Thrown by handlers to return a JSON-RPC error with a specific code. */
export class RpcFailure extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// stdout carries protocol frames only (ADR-0003). Everything else goes to stderr via log().
const writeStdout: Write = (frame) => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

const METRICS = process.env.AGENTCHAINER_METRICS === "1";

export function notify<N extends keyof Notifications>(method: N, params: Notifications[N]): void {
  writeStdout({ jsonrpc: "2.0", method, params, ...(METRICS ? { ts: Date.now() } : {}) });
}

/**
 * Reads NDJSON JSON-RPC requests from stdin and dispatches them. When stdin closes (host gone),
 * finishes in-flight requests, runs `onClose`, flushes stdout and exits.
 */
export function serve(handlers: Handlers, onClose?: () => void): void {
  const inflight = new Set<Promise<void>>();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const done: Promise<void> = dispatch(line, handlers, writeStdout).finally(() => inflight.delete(done));
    inflight.add(done);
  });
  rl.on("close", () => {
    void Promise.allSettled(inflight).then(() => {
      onClose?.();
      process.stdout.write("", () => process.exit(0));
    });
  });
}

/** Validates one request, runs its handler, validates the result, and writes exactly one response. */
export async function dispatch(line: string, handlers: Handlers, write: Write): Promise<void> {
  let req: RpcRequest;
  try {
    req = JSON.parse(line) as RpcRequest;
  } catch {
    log("rpc: ignoring non-JSON line");
    return;
  }
  const fail = (code: number, message: string) => write({ jsonrpc: "2.0", id: req.id, error: { code, message } });

  if (!isMethodName(req.method)) return fail(RpcErrorCode.methodNotFound, `Unknown method ${req.method}`);
  const schema = methodSchemas[req.method];
  const params = schema.params.safeParse(req.params ?? {});
  if (!params.success) {
    return fail(RpcErrorCode.invalidParams, `Invalid params for ${req.method}: ${describeIssues(params.error)}`);
  }

  try {
    // Each handler's param type matches its own schema; TypeScript can't correlate the two through the union.
    const handler = handlers[req.method] as (p: unknown) => unknown;
    const result = schema.result.safeParse(await handler(params.data));
    if (!result.success) {
      return fail(RpcErrorCode.internal, `Invalid result from ${req.method}: ${describeIssues(result.error)}`);
    }
    write({ jsonrpc: "2.0", id: req.id, result: result.data });
  } catch (err) {
    const code = err instanceof RpcFailure ? err.code : -32000;
    fail(code, err instanceof Error ? err.message : String(err));
  }
}
