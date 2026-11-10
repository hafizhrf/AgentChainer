import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Cli } from "../deploy/cli.ts";

/**
 * A short-lived `codex app-server` for one-off questions (CP-01's account usage, M9-09's thread list and history): it
 * starts, says hello, answers, and is stopped. No model calls. A step or chat keeps its own long-lived one
 * (codex.ts).
 */
export type Frame = { id?: number; result?: unknown; error?: { message?: string } };
export type Ask = (method: string, params: unknown) => Promise<Frame>;

const TIMEOUT_MS = 20_000;

export async function withAppServer<T>(cli: Cli, cwd: string | undefined, use: (ask: Ask) => Promise<T>): Promise<T> {
  const child = spawn(cli.bin, [...cli.prefix, "app-server"], {
    ...(cwd ? { cwd } : {}),
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const pending = new Map<number, (f: Frame) => void>();
  let next = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const f = JSON.parse(line) as Frame;
      if (typeof f.id === "number") pending.get(f.id)?.(f);
    } catch {
      // not a frame
    }
  });
  const exited = new Promise<never>((_, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`codex app-server exited (${code})`)));
  });
  // Its own stop, after the answer, isn't a failure.
  exited.catch(() => undefined);
  const request = (method: string, params: unknown) =>
    new Promise<Frame>((resolve, reject) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      setTimeout(() => reject(new Error(`${method} timed out`)), TIMEOUT_MS).unref();
    });
  const ask: Ask = (method, params) => Promise.race([request(method, params), exited]);
  try {
    await ask("initialize", {
      clientInfo: { name: "agentchainer", title: "AgentChainer", version: "0" },
      capabilities: null,
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return await use(ask);
  } finally {
    child.kill();
  }
}
