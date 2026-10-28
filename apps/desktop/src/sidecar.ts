import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MethodName, Methods, Notifications, RpcError } from "@agentchainer/protocol";

/** JSON-RPC client for the sidecar. Frames travel through the Rust core (ADR-0003). */

export type Notification = {
  [N in keyof Notifications]: { method: N; params: Notifications[N] };
}[keyof Notifications];

type Pending = { resolve: (result: unknown) => void; reject: (err: Error) => void };

let nextId = 1;
const pending = new Map<number, Pending>();
const subscribers = new Set<(n: Notification) => void>();
const exitSubscribers = new Set<(status: string) => void>();
let connected: Promise<void> | null = null;

/** Starts listening for sidecar frames. Idempotent: React StrictMode runs effects twice in dev. */
export function connect(): Promise<void> {
  connected ??= Promise.all([
    listen<string>("sidecar://frame", (e) => handleFrame(e.payload)),
    listen<string>("sidecar://exit", (e) => {
      for (const p of pending.values()) p.reject(new Error(`Sidecar exited (${e.payload})`));
      pending.clear();
      for (const fn of exitSubscribers) fn(e.payload);
    }),
  ]).then(() => undefined);
  return connected;
}

function handleFrame(raw: string): void {
  const frame = JSON.parse(raw) as {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: RpcError;
  };
  if (typeof frame.id === "number" && frame.method === undefined) {
    const p = pending.get(frame.id);
    if (!p) return;
    pending.delete(frame.id);
    if (frame.error) p.reject(new Error(frame.error.message));
    else p.resolve(frame.result);
  } else if (frame.method) {
    const notification = { method: frame.method, params: frame.params } as Notification;
    for (const fn of subscribers) fn(notification);
  }
}

export async function request<M extends MethodName>(
  method: M,
  params: Methods[M]["params"],
): Promise<Methods[M]["result"]> {
  await connect();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: (result) => resolve(result as Methods[M]["result"]), reject });
    invoke("sidecar_send", { frame: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }).catch(
      (err: unknown) => {
        pending.delete(id);
        reject(new Error(String(err)));
      },
    );
  });
}

export function subscribe(fn: (n: Notification) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function onExit(fn: (status: string) => void): () => void {
  exitSubscribers.add(fn);
  return () => exitSubscribers.delete(fn);
}
