import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { MethodName, Methods, Task } from "@agentchainer/protocol";

type Reply = { result?: unknown; error?: { message: string } };
type PermissionRequest = {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: unknown;
  task?: { label?: string };
};

/**
 * A sidecar driven over JSON-RPC, for the maintainer scripts that run tasks with real model calls (`live-task.ts`,
 * `benchmark.ts`). Every tool approval is answered yes, so use it only on a throwaway copy of a fixture.
 */
export class SidecarClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (m: Reply) => void>();
  private readonly updates = new Set<(task: Task) => void>();
  private id = 0;
  /** Called for each approval before it's answered yes. */
  onPermission: (p: PermissionRequest) => void = () => undefined;

  constructor() {
    this.child = spawn(process.execPath, [fileURLToPath(new URL("../main.ts", import.meta.url))], {
      stdio: ["pipe", "pipe", "inherit"],
    }) as unknown as ChildProcessWithoutNullStreams;
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const m = JSON.parse(line);
      if (m.id != null) {
        this.pending.get(m.id)?.(m);
        this.pending.delete(m.id);
        return;
      }
      if (m.method === "permission.request") {
        const p: PermissionRequest = m.params;
        this.onPermission(p);
        void this.request("permission.respond", { sessionId: p.sessionId, requestId: p.requestId, allow: true });
      }
      if (m.method === "task.updated") for (const f of this.updates) f(m.params.task);
    });
  }

  async request<M extends MethodName>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]> {
    const n = ++this.id;
    const reply = new Promise<Reply>((r) => this.pending.set(n, r));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    const m = await reply;
    if (m.error) throw new Error(`${method}: ${m.error.message}`);
    return m.result as Methods[M]["result"];
  }

  /** Listens to `task.updated`; returns the function that stops listening. */
  onUpdate(f: (task: Task) => void): () => void {
    this.updates.add(f);
    return () => this.updates.delete(f);
  }

  /** Resolves with the task once it leaves `running`/`ready`. */
  ended(id: string): Promise<Task> {
    return new Promise((resolve) => {
      const stop = this.onUpdate((t) => {
        if (t.id === id && !["running", "ready"].includes(t.state)) {
          stop();
          resolve(t);
        }
      });
    });
  }

  /**
   * Closes stdin and lets the sidecar end its sessions and exit: on Windows a folder that a live process still runs
   * in can't be removed (EPERM). Killed only if it hangs.
   */
  async close(): Promise<void> {
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 10_000);
    await exited;
    clearTimeout(timer);
  }
}
