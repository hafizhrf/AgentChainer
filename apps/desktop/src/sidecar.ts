import {
  describeIssues,
  isNotificationName,
  type MethodName,
  type Methods,
  methodSchemas,
  type Notifications,
  notificationSchemas,
  type RpcError,
} from "@agentchainer/protocol";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * JSON-RPC client for the sidecar. Frames travel through the Rust core (ADR-0003), and every result and
 * notification is validated against the protocol schemas before the UI sees it (M1-02).
 */

export type Notification = {
  [N in keyof Notifications]: { method: N; params: Notifications[N] };
}[keyof Notifications];

/** Emitted by the Rust supervisor (M1-01) when the sidecar process stops. */
export type SidecarExit = { status: string; restarting: boolean };

/** A JSON-RPC error from the sidecar, with its code (`RpcErrorCode`). */
export class SidecarError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export const isRpcError = (err: unknown, code: number): boolean => err instanceof SidecarError && err.code === code;

type Pending = { method: MethodName; resolve: (result: unknown) => void; reject: (err: Error) => void };

let nextId = 1;
/** Sidecar-to-UI latency of each streamed text delta, in ms. Only filled when the sidecar sends `ts` (spike S2). */
const deltaLatencies: number[] = [];
const pending = new Map<number, Pending>();
const subscribers = new Set<(n: Notification) => void>();
const exitSubscribers = new Set<(exit: SidecarExit) => void>();
const readySubscribers = new Set<() => void>();
let connected: Promise<void> | null = null;

/** Starts listening for sidecar frames. Idempotent: React StrictMode runs effects twice in dev. */
export function connect(): Promise<void> {
  connected ??= Promise.all([
    listen<string>("sidecar://frame", (e) => handleFrame(e.payload)),
    listen<SidecarExit>("sidecar://exit", (e) => {
      for (const p of pending.values()) p.reject(new Error(`Agent runtime stopped (${e.payload.status})`));
      pending.clear();
      for (const fn of exitSubscribers) fn(e.payload);
    }),
    listen("sidecar://ready", () => {
      for (const fn of readySubscribers) fn();
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
    ts?: number;
  };
  const event = (frame.params as { event?: { type?: string } } | undefined)?.event;
  if (typeof frame.ts === "number" && event?.type === "text.delta") {
    deltaLatencies.push(Date.now() - frame.ts);
  }
  if (typeof frame.id === "number" && frame.method === undefined) {
    const p = pending.get(frame.id);
    if (!p) return;
    pending.delete(frame.id);
    if (frame.error) {
      p.reject(new SidecarError(frame.error.code, frame.error.message));
      return;
    }
    const result = methodSchemas[p.method].result.safeParse(frame.result);
    if (result.success) p.resolve(result.data);
    else p.reject(new Error(`Invalid result for ${p.method}: ${describeIssues(result.error)}`));
  } else if (frame.method) {
    if (!isNotificationName(frame.method)) {
      console.warn(`Ignoring unknown notification ${frame.method}`);
      return;
    }
    const params = notificationSchemas[frame.method].safeParse(frame.params);
    if (!params.success) {
      console.warn(`Ignoring invalid ${frame.method}: ${describeIssues(params.error)}`);
      return;
    }
    const notification = { method: frame.method, params: params.data } as Notification;
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
    pending.set(id, { method, resolve: (result) => resolve(result as Methods[M]["result"]), reject });
    invoke("sidecar_send", { frame: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }).catch((err: unknown) => {
      pending.delete(id);
      reject(new Error(String(err)));
    });
  });
}

/** Rejects if the sidecar doesn't answer within `ms`; used by the health ping (M1-01). */
export function requestWithTimeout<M extends MethodName>(
  method: M,
  params: Methods[M]["params"],
  ms: number,
): Promise<Methods[M]["result"]> {
  return Promise.race([
    request(method, params),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${method} timed out after ${ms} ms`)), ms)),
  ]);
}

/** Returns and clears the collected delta latencies (spike S2 self-test). */
export function takeDeltaLatencies(): number[] {
  return deltaLatencies.splice(0);
}

export function subscribe(fn: (n: Notification) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function onExit(fn: (exit: SidecarExit) => void): () => void {
  exitSubscribers.add(fn);
  return () => exitSubscribers.delete(fn);
}

/** Fires when a (re)started sidecar is ready to take requests. */
export function onReady(fn: () => void): () => void {
  readySubscribers.add(fn);
  return () => readySubscribers.delete(fn);
}
