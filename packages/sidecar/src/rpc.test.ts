import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RpcFrame } from "@agentchainer/protocol";
import { dispatch, type Handlers, RpcFailure } from "./rpc.ts";

/** Handlers that should never be reached are typed loosely; each test overrides the one it exercises. */
const unreachable = () => {
  throw new Error("not under test");
};
const base = Object.fromEntries(
  [
    "system.hello",
    "system.ping",
    "env.check",
    "sdk.prepare",
    "debug.log",
    "session.start",
    "session.send",
    "session.interrupt",
    "session.setMode",
    "permission.respond",
  ].map((m) => [m, unreachable]),
) as unknown as Handlers;

async function call(line: string, handlers: Partial<Handlers>) {
  const frames: RpcFrame[] = [];
  await dispatch(line, { ...base, ...handlers }, (f) => frames.push(f));
  assert.equal(frames.length, 1, "exactly one response per request");
  return frames[0] as { result?: unknown; error?: { code: number; message: string } };
}

const req = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

describe("dispatch", () => {
  it("passes validated params to the handler and returns its result", async () => {
    const res = await call(req("session.send", { text: "hi" }), {
      "session.send": ({ text }) => ({ ok: text === "hi" }) as never,
    });
    assert.deepEqual(res.result, { ok: true });
  });

  it("rejects params that don't match the schema, before the handler runs", async () => {
    const res = await call(req("session.start", { cwd: "" }), {});
    assert.equal(res.error?.code, -32602);
    assert.match(res.error?.message ?? "", /Invalid params for session.start/);
    const mode = await call(req("session.setMode", { mode: "bypassPermissions" }), {});
    assert.equal(mode.error?.code, -32602, "bypassPermissions is not an allowed mode");
  });

  it("rejects unknown methods", async () => {
    assert.equal((await call(req("system.shutdown"), {})).error?.code, -32601);
  });

  it("refuses to send a result that breaks the contract", async () => {
    const res = await call(req("system.ping"), { "system.ping": () => ({ ok: false }) as never });
    assert.equal(res.error?.code, -32603);
  });

  it("maps RpcFailure codes and plain errors", async () => {
    const failure = await call(req("session.interrupt"), {
      "session.interrupt": () => {
        throw new RpcFailure(-32001, "No active session.");
      },
    });
    assert.deepEqual(failure.error, { code: -32001, message: "No active session." });
    const crash = await call(req("system.ping"), {
      "system.ping": () => {
        throw new Error("boom");
      },
    });
    assert.deepEqual(crash.error, { code: -32000, message: "boom" });
  });
});
