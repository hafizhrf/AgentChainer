import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Finding, WorkspaceProfile } from "@agentchainer/protocol";
import { auditWorkspace, saveProfile } from "./audit.ts";
import { detectWorkspace } from "./detect.ts";
import { makeTargets, requirementNames, tomlArray, tomlDependencyNames, yamlList } from "./manifests.ts";

/**
 * Detector and audit snapshots per fixture repo (M2-28). Each fixture is copied outside this repo and given the git
 * state its scenario needs, so git checks don't see AgentChainer's own repo. Regenerate with UPDATE_SNAPSHOTS=1.
 */
const FIXTURES = new URL("../../../../fixtures/", import.meta.url);
const temps: string[] = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, stdio: "ignore" });

type Setup = { git: boolean; remote?: boolean; files?: Record<string, string> };
const SETUPS: Record<string, Setup> = {
  "ts-pnpm-vite": { git: true, remote: true },
  "python-uv-fastapi": { git: true },
  "flutter-app": { git: true },
  "go-service": { git: true },
  empty: { git: false },
  "legacy-messy": { git: true, files: { ".env": "DEBUG=1\n" } },
  "monorepo-pnpm": { git: true },
  "sample-app": { git: true },
};

function scan(name: string): { profile: WorkspaceProfile; findings: Finding[] } {
  const setup = SETUPS[name];
  assert.ok(setup, `no setup for fixture ${name}`);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `ac-detect-${name}-`)));
  temps.push(dir);
  cpSync(new URL(name, FIXTURES), dir, { recursive: true });
  for (const [file, text] of Object.entries(setup.files ?? {})) writeFileSync(join(dir, file), text);
  if (setup.git) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A", "-f");
    git(dir, "commit", "-q", "-m", "fixture");
    if (setup.remote) git(dir, "remote", "add", "origin", "https://example.invalid/repo.git");
  }
  const profile = detectWorkspace(dir);
  return { profile, findings: auditWorkspace(dir, profile) };
}

const status = (findings: Finding[], id: string) => findings.find((f) => f.id === id)?.status;
const cmd = (p: WorkspaceProfile, path: string, kind: string) => {
  const commands = p.packages.find((x) => x.path === path)?.commands as Record<string, { run: string }> | undefined;
  return commands?.[kind]?.run;
};

describe("fixture snapshots", () => {
  for (const name of Object.keys(SETUPS)) {
    it(`${name} matches test/snapshots/${name}.json`, () => {
      const file = new URL(`../../test/snapshots/${name}.json`, import.meta.url);
      const text = `${JSON.stringify(scan(name), null, 2)}\n`;
      if (process.env.UPDATE_SNAPSHOTS === "1") writeFileSync(file, text);
      assert.equal(readFileSync(file, "utf8"), text);
    });
  }
});

describe("detection per stack", () => {
  it("TS with pnpm and Vite: scripts win, frameworks and CI found", () => {
    const { profile, findings } = scan("ts-pnpm-vite");
    assert.deepEqual([profile.stacks, profile.monorepo, profile.ci], [["node"], null, ["github-actions"]]);
    const pkg = profile.packages[0];
    assert.deepEqual(
      [pkg?.packageManager, pkg?.frameworks, pkg?.testFrameworks],
      ["pnpm", ["vite", "react"], ["vitest"]],
    );
    assert.equal(cmd(profile, ".", "test"), "pnpm test");
    assert.equal(cmd(profile, ".", "typecheck"), "pnpm run typecheck", "the script beats the tsconfig fallback");
    assert.equal(status(findings, "remote.ok"), "ok");
    assert.equal(status(findings, "gitignore.env"), "missing");
  });

  it("Python with uv: tools from pyproject, extras don't break dependency parsing", () => {
    const { profile, findings } = scan("python-uv-fastapi");
    const pkg = profile.packages[0];
    assert.deepEqual([pkg?.stack, pkg?.packageManager, pkg?.frameworks], ["python", "uv", ["fastapi"]]);
    assert.deepEqual(
      ["install", "test", "lint", "format", "typecheck"].map((k) => cmd(profile, ".", k)),
      ["uv sync", "uv run pytest", "uv run ruff check .", "uv run ruff format .", "uv run mypy ."],
    );
    assert.equal(status(findings, "claude-md.ok"), "ok", "CLAUDE.md mentions `uv run pytest`");
    assert.equal(status(findings, "gitignore.ok"), "ok");
  });

  it("Flutter and Go: SDK conventions, and Makefile targets over conventions", () => {
    const flutter = scan("flutter-app").profile;
    assert.deepEqual(
      [flutter.stacks, cmd(flutter, ".", "test"), cmd(flutter, ".", "lint")],
      [["flutter"], "flutter test", "flutter analyze"],
    );
    const go = scan("go-service").profile;
    assert.deepEqual(
      [cmd(go, ".", "test"), cmd(go, ".", "lint"), cmd(go, ".", "build"), go.packages[0]?.frameworks],
      ["make test", "make lint", "go build ./...", ["chi"]],
    );
  });

  it("an empty folder: nothing detected, every gap has a fix", () => {
    const { profile, findings } = scan("empty");
    assert.deepEqual(profile, { stacks: [], monorepo: null, packages: [], ci: [] });
    for (const id of ["claude-md.missing", "tests.missing", "ci.missing", "git.missing"]) {
      const f = findings.find((x) => x.id === id);
      assert.ok(f?.fix, `${id} has a fix`);
    }
    assert.ok(
      findings.every((f) => f.status === "ok" || f.status === "info" || f.fix),
      "no finding without a fix action",
    );
  });

  it("a messy legacy repo: two stacks in one folder, npm's placeholder test ignored, committed .env flagged", () => {
    const { profile, findings } = scan("legacy-messy");
    assert.deepEqual(profile.stacks, ["node", "python"]);
    assert.equal(cmd(profile, ".", "test"), undefined);
    assert.equal(status(findings, "tests.missing"), "missing");
    assert.equal(status(findings, "env.tracked"), "warn");
    assert.deepEqual(profile.packages.find((p) => p.stack === "python")?.frameworks, ["flask"]);
  });

  it("a pnpm monorepo: packages from the workspace globs", () => {
    const { profile } = scan("monorepo-pnpm");
    assert.equal(profile.monorepo, "pnpm-workspace");
    assert.deepEqual(
      profile.packages.map((p) => [p.path, p.name, p.frameworks]),
      [
        [".", "monorepo-pnpm", []],
        ["apps/web", "web", ["next", "react"]],
        ["packages/ui", "@repo/ui", []],
      ],
    );
    assert.equal(cmd(profile, "packages/ui", "test"), "pnpm test");
  });
});

describe("package-manager variants without a fixture repo", () => {
  const folder = (files: Record<string, string>) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ac-variant-")));
    temps.push(dir);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return detectWorkspace(dir);
  };

  it("yarn and bun from their lockfiles, with their own run syntax", () => {
    const scripts = JSON.stringify({ name: "x", scripts: { lint: "eslint .", test: "jest" } });
    const yarn = folder({ "package.json": scripts, "yarn.lock": "" });
    assert.deepEqual(
      [cmd(yarn, ".", "install"), cmd(yarn, ".", "lint"), cmd(yarn, ".", "test")],
      ["yarn install", "yarn lint", "yarn test"],
    );
    const bun = folder({ "package.json": scripts, "bun.lock": "" });
    assert.deepEqual(
      [cmd(bun, ".", "lint"), cmd(bun, ".", "test")],
      ["bun run lint", "bun run test"],
      "not bun's runner",
    );
  });

  it("poetry from pyproject, and justfile targets", () => {
    const poetry = folder({
      "pyproject.toml":
        '[tool.poetry]\nname = "svc"\n\n[tool.poetry.dependencies]\npython = "^3.12"\ndjango = "^5"\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8"\n',
      "manage.py": "",
      justfile: "lint:\n  ruff check .\n",
    });
    const pkg = poetry.packages[0];
    assert.deepEqual([pkg?.packageManager, pkg?.name, pkg?.frameworks], ["poetry", "svc", ["django"]]);
    assert.deepEqual(
      [cmd(poetry, ".", "install"), cmd(poetry, ".", "test"), cmd(poetry, ".", "dev"), cmd(poetry, ".", "lint")],
      ["poetry install", "poetry run pytest", "poetry run python manage.py runserver", "just lint"],
    );
  });
});

describe("manifest readers", () => {
  it("reads TOML arrays with extras and nested brackets", () => {
    const body = 'dependencies = [\n  "uvicorn[standard]>=0.30",\n  "fastapi",\n]\nother = ["x"]';
    assert.deepEqual(tomlDependencyNames(tomlArray(body, "dependencies")), ["uvicorn", "fastapi"]);
  });

  it("reads requirements, YAML lists and make targets", () => {
    assert.deepEqual(requirementNames("Flask==3.0\n# c\n-r more.txt\nzope.interface>=5 ; python_version<'4'\n"), [
      "flask",
      "zope-interface",
    ]);
    assert.deepEqual(yamlList('packages:\n  - "apps/*"\n  - packages/* # libs\nother: 1\n', "packages"), [
      "apps/*",
      "packages/*",
    ]);
    assert.deepEqual(makeTargets("X := 1\n.PHONY: test\ntest: build\n\tgo test\nfmt arg:\n\tgofmt\n"), ["test", "fmt"]);
  });
});

describe("saveProfile", () => {
  it("writes .agentchainer/profile.json and keeps it out of git, idempotently", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ac-profile-")));
    temps.push(dir);
    const profile = detectWorkspace(dir);
    saveProfile(dir, profile);
    saveProfile(dir, profile);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".agentchainer", "profile.json"), "utf8")), profile);
    assert.equal(readFileSync(join(dir, ".agentchainer", ".gitignore"), "utf8"), "profile.json\n");
  });
});
