import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as AgentSdk from "@anthropic-ai/claude-agent-sdk";
import { log } from "./rpc.ts";
import pin from "./sdk-pin.json" with { type: "json" };
import type { SdkPin } from "./sdk-pin.ts";

export type AgentSdkModule = typeof AgentSdk;
export type LoadedSdk = { sdk: AgentSdkModule; version: string; source: SdkSource };

let loading: Promise<LoadedSdk> | null = null;

/**
 * Loads the Claude Agent SDK.
 * - Dev (no `AGENTCHAINER_DATA_DIR`): from node_modules, as installed by pnpm.
 * - Packaged app: the pinned SDK in the app data dir. It is downloaded from npm and verified on first use, because
 *   we may not redistribute it (ADR-0003, M0-03).
 */
export function loadSdk(): Promise<LoadedSdk> {
  loading ??= (async (): Promise<LoadedSdk> => {
    const dataDir = process.env.AGENTCHAINER_DATA_DIR;
    if (!dataDir) {
      return { sdk: await import("@anthropic-ai/claude-agent-sdk"), version: pin.version, source: "node_modules" };
    }
    const { entry, source } = await ensureSdk(join(dataDir, "sdk"), pin);
    return { sdk: (await import(pathToFileURL(entry).href)) as AgentSdkModule, version: pin.version, source };
  })();
  loading.catch(() => {
    loading = null; // let the next session.start retry, e.g. after the user goes back online
  });
  return loading;
}

export function sriOf(data: Uint8Array): string {
  return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

export type SdkSource = "node_modules" | "download" | "cache";

/** Returns the verified `sdk.mjs`, downloading and extracting the pinned tarball first if needed. */
export async function ensureSdk(
  root: string,
  p: SdkPin,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 120_000,
): Promise<{ entry: string; source: SdkSource }> {
  const dir = join(root, p.version);
  const entry = join(dir, "package", "sdk.mjs");
  const marker = join(dir, ".integrity");
  if (existsSync(entry) && existsSync(marker) && readFileSync(marker, "utf8") === p.integrity) {
    return { entry, source: "cache" };
  }

  log(`sdk: downloading ${p.name}@${p.version}`);
  // A stalled connection must not hang session start forever (seen once on a flaky network), so the whole download,
  // body included, has a deadline. The next session.start retries.
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  let data: Uint8Array;
  try {
    res = await fetchImpl(p.tarball, { signal });
    data = res.ok ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array();
  } catch (err) {
    if (signal.aborted) {
      throw new Error(
        `Downloading the Claude Agent SDK timed out after ${Math.round(timeoutMs / 1000)} s. Check your connection and try again.`,
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Couldn't download the Claude Agent SDK (offline or blocked by a proxy?): ${reason}`);
  }
  if (!res.ok) throw new Error(`Downloading the Claude Agent SDK failed: HTTP ${res.status}`);
  if (sriOf(data) !== p.integrity) {
    throw new Error("The downloaded Claude Agent SDK failed its integrity check, so it was not loaded.");
  }

  // Extract into a temp dir and rename, so a crash never leaves a half-written SDK that looks valid.
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const tgz = join(tmp, "sdk.tgz");
  writeFileSync(tgz, data);
  const tar = spawnSync("tar", ["-xzf", tgz, "-C", tmp], { encoding: "utf8" });
  if (tar.status !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(
      `Extracting the Claude Agent SDK failed: ${tar.stderr || tar.error?.message || `tar exit ${tar.status}`}`,
    );
  }
  rmSync(tgz);
  writeFileSync(join(tmp, ".integrity"), p.integrity);
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  log(`sdk: verified and installed at ${dir}`);
  return { entry, source: "download" };
}
