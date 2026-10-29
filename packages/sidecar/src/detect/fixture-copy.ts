import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test helper: copies a repo from `fixtures/` outside this repository and gives it the git state its scenario needs,
 * so git checks don't see AgentChainer's own repo (M2-28).
 */

type Setup = { git: boolean; remote?: string; files?: Record<string, string> };

export const FIXTURE_SETUPS: Record<string, Setup> = {
  "ts-pnpm-vite": { git: true, remote: "https://github.com/example/ts-pnpm-vite.git" },
  "python-uv-fastapi": { git: true },
  "flutter-app": { git: true },
  "go-service": { git: true },
  empty: { git: false },
  "legacy-messy": { git: true, files: { ".env": "DEBUG=1\n" } },
  "monorepo-pnpm": { git: true },
  "sample-app": { git: true },
};

const copies: string[] = [];

export function copyFixture(name: string): string {
  const setup = FIXTURE_SETUPS[name];
  if (!setup) throw new Error(`no setup for fixture ${name}`);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `ac-fixture-${name}-`)));
  copies.push(dir);
  cpSync(new URL(`../../../../fixtures/${name}`, import.meta.url), dir, { recursive: true });
  for (const [file, text] of Object.entries(setup.files ?? {})) writeFileSync(join(dir, file), text);
  if (setup.git) {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
        cwd: dir,
        stdio: "ignore",
      });
    git("init", "-q", "-b", "main");
    git("add", "-A", "-f");
    git("commit", "-q", "-m", "fixture");
    if (setup.remote) git("remote", "add", "origin", setup.remote);
  }
  return dir;
}

export function removeFixtureCopies(): void {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
}
