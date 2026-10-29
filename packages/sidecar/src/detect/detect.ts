import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CommandKind, DetectedCommand, PackageProfile, WorkspaceProfile } from "@agentchainer/protocol";
import {
  makeTargets,
  requirementNames,
  tomlArray,
  tomlDependencyNames,
  tomlKeys,
  tomlSections,
  tomlString,
  yamlList,
  yamlScalar,
} from "./manifests.ts";

/**
 * Stack and command detection for the workspace bootstrap (M2-06/M2-07). Reads manifests only; runs nothing.
 * Commands are meant to run in their package's folder (`PackageProfile.path`).
 */

/** Never descended into. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
  ".dart_tool",
  "coverage",
]);
/** Without a workspace config, manifests in these folders are samples or test data, not packages of the repo. */
const NON_PACKAGE_DIRS = new Set([
  "fixtures",
  "examples",
  "example",
  "samples",
  "sample",
  "test",
  "tests",
  "testdata",
  "docs",
]);
const MAX_SCAN_DEPTH = 2;

type Candidate = DetectedCommand & { rank: number };
type Commands = Partial<Record<CommandKind, Candidate[]>>;

const CONFIDENCE_RANK = { high: 30, medium: 20, low: 10 } as const;
/** Among equally confident commands: the project's own scripts, then make/just targets, then conventions. */
const SOURCE_RANK = { script: 3, make: 2, convention: 1 } as const;

function add(
  commands: Commands,
  kind: CommandKind,
  run: string,
  source: string,
  confidence: DetectedCommand["confidence"],
  origin: keyof typeof SOURCE_RANK,
) {
  const list = commands[kind] ?? [];
  list.push({ run, source, confidence, rank: CONFIDENCE_RANK[confidence] + SOURCE_RANK[origin] });
  commands[kind] = list;
}

function best(commands: Commands): PackageProfile["commands"] {
  const out: PackageProfile["commands"] = {};
  for (const [kind, list] of Object.entries(commands) as [CommandKind, Candidate[]][]) {
    const top = list.reduce((a, b) => (b.rank > a.rank ? b : a));
    out[kind] = { run: top.run, source: top.source, confidence: top.confidence };
  }
  return out;
}

class Files {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  abs = (rel: string) => path.join(this.root, ...rel.split("/").filter((p) => p && p !== "."));
  exists = (rel: string) => existsSync(this.abs(rel));
  read(rel: string): string | null {
    try {
      return readFileSync(this.abs(rel), "utf8");
    } catch {
      return null;
    }
  }
  json(rel: string): Record<string, unknown> | null {
    const text = this.read(rel);
    if (text === null) return null;
    try {
      const v: unknown = JSON.parse(text);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  dirs(rel: string): string[] {
    try {
      return readdirSync(this.abs(rel), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }
  files(rel: string): string[] {
    try {
      return readdirSync(this.abs(rel)).filter((n) => {
        try {
          return statSync(path.join(this.abs(rel), n)).isFile();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }
}

const join = (dir: string, name: string) => (dir === "." ? name : `${dir}/${name}`);
const MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "Pipfile",
  "pubspec.yaml",
  "go.mod",
  "Cargo.toml",
];
const hasManifest = (f: Files, dir: string) => MANIFESTS.some((m) => f.exists(join(dir, m)));

export function detectWorkspace(root: string): WorkspaceProfile {
  const f = new Files(root);
  const { monorepo, dirs } = packageDirs(f);
  const packages = dirs.flatMap((dir) => detectPackages(f, dir));
  return {
    stacks: [...new Set(packages.map((p) => p.stack))].sort(),
    monorepo: monorepo ?? (dirs.length > 1 ? "multiple" : null),
    packages,
    ci: detectCi(f),
  };
}

/** Package folders: the workspace config's globs when there is one, otherwise a shallow scan. */
function packageDirs(f: Files): { monorepo: string | null; dirs: string[] } {
  const rootPkg = f.json("package.json");
  const pnpm = f.read("pnpm-workspace.yaml");
  const npmWs = rootPkg?.workspaces;
  const npmGlobs = Array.isArray(npmWs)
    ? npmWs
    : Array.isArray((npmWs as { packages?: unknown } | undefined)?.packages)
      ? (npmWs as { packages: unknown[] }).packages
      : null;
  const goWork = f.read("go.work");
  const cargoWs = tomlSections(f.read("Cargo.toml") ?? "").get("workspace");

  // A polyglot repo can have several workspace configs (e.g. pnpm for the UI and Cargo for a Rust core): use them all.
  const tools: string[] = [];
  const globs: string[] = [];
  if (pnpm !== null) {
    tools.push("pnpm-workspace");
    globs.push(...yamlList(pnpm, "packages"));
  } else if (npmGlobs) {
    tools.push(f.exists("yarn.lock") ? "yarn-workspaces" : "npm-workspaces");
    globs.push(...npmGlobs.filter((g): g is string => typeof g === "string"));
  }
  if (goWork !== null) {
    tools.push("go-work");
    globs.push(
      ...[...goWork.matchAll(/^\s*(?:use\s+)?(\.\/?[^\s()]*)\s*$/gm)].map((m) => (m[1] ?? "").replace(/^\.\/?/, "")),
    );
  }
  if (cargoWs) {
    tools.push("cargo-workspace");
    globs.push(...[...tomlArray(cargoWs, "members").matchAll(/["']([^"']+)["']/g)].map((m) => m[1] ?? ""));
  }
  const tool = tools.length ? tools.join("+") : null;

  if (tool) {
    const include = globs.filter((g) => !g.startsWith("!"));
    const exclude = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
    const matched = include.flatMap((g) => expand(f, g)).filter((d) => !exclude.some((x) => globMatch(x, d)));
    const dirs = [...new Set([...(hasManifest(f, ".") ? ["."] : []), ...matched.filter((d) => hasManifest(f, d))])];
    return { monorepo: tool, dirs: dirs.sort((a, b) => (a === "." ? -1 : b === "." ? 1 : a.localeCompare(b))) };
  }

  const found: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (hasManifest(f, dir)) found.push(dir);
    if (depth >= MAX_SCAN_DEPTH) return;
    for (const name of f.dirs(dir)) {
      if (name.startsWith(".") || NON_PACKAGE_DIRS.has(name)) continue;
      visit(join(dir, name), depth + 1);
    }
  };
  visit(".", 0);
  return { monorepo: null, dirs: found };
}

/** Expands a workspace glob (`packages/*`, `apps/**`, `tools/cli`) to existing folders. */
function expand(f: Files, glob: string): string[] {
  const parts = glob.replace(/^\.\//, "").replace(/\/$/, "").split("/").filter(Boolean);
  const walk = (dir: string, i: number): string[] => {
    if (i === parts.length) return [dir];
    const part = parts[i] ?? "";
    if (part === "**") {
      // Zero or more folders: try the rest here, and keep `**` for every subfolder.
      return [...walk(dir, i + 1), ...f.dirs(dir).flatMap((d) => walk(join(dir, d), i))];
    }
    const re = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    return f
      .dirs(dir)
      .filter((d) => re.test(d))
      .flatMap((d) => walk(join(dir, d), i + 1));
  };
  return walk(".", 0).filter((d) => d !== ".");
}

function globMatch(glob: string, dir: string): boolean {
  const re = glob
    .replace(/^\.\//, "")
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${re}$`).test(dir);
}

function detectCi(f: Files): string[] {
  const ci: string[] = [];
  if (f.files(".github/workflows").some((n) => /\.ya?ml$/.test(n))) ci.push("github-actions");
  if (f.exists(".gitlab-ci.yml")) ci.push("gitlab-ci");
  if (f.exists(".circleci/config.yml")) ci.push("circleci");
  if (f.exists("azure-pipelines.yml")) ci.push("azure-pipelines");
  if (f.exists("bitbucket-pipelines.yml")) ci.push("bitbucket-pipelines");
  if (f.exists("Jenkinsfile")) ci.push("jenkins");
  return ci;
}

/** One profile per stack found in the folder (a legacy repo can be Node and Python at once). */
function detectPackages(f: Files, dir: string): PackageProfile[] {
  const out: PackageProfile[] = [];
  if (f.exists(join(dir, "package.json"))) out.push(detectNode(f, dir));
  if (["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"].some((m) => f.exists(join(dir, m)))) {
    out.push(detectPython(f, dir));
  }
  if (f.exists(join(dir, "pubspec.yaml"))) out.push(detectDart(f, dir));
  if (f.exists(join(dir, "go.mod"))) out.push(detectGo(f, dir));
  if (f.exists(join(dir, "Cargo.toml")) && tomlSections(f.read(join(dir, "Cargo.toml")) ?? "").has("package")) {
    out.push(detectRust(f, dir));
  }
  return out;
}

/** Make/just targets that map to a command kind. */
const TARGETS: Record<CommandKind, string[]> = {
  install: ["install", "deps", "setup", "bootstrap"],
  build: ["build"],
  lint: ["lint", "vet"],
  format: ["fmt", "format"],
  typecheck: ["typecheck", "types", "type-check"],
  test: ["test", "tests"],
  dev: ["dev", "run", "serve", "start"],
};

function addMakeTargets(f: Files, dir: string, commands: Commands) {
  for (const [file, tool] of [
    ["Makefile", "make"],
    ["makefile", "make"],
    ["justfile", "just"],
    ["Justfile", "just"],
  ] as const) {
    const text = f.read(join(dir, file));
    if (text === null) continue;
    const targets = new Set(makeTargets(text));
    for (const [kind, names] of Object.entries(TARGETS) as [CommandKind, string[]][]) {
      const t = names.find((n) => targets.has(n));
      if (t) add(commands, kind, `${tool} ${t}`, file, "high", "make");
    }
  }
}

function profile(
  dir: string,
  base: Omit<PackageProfile, "path" | "commands">,
  commands: Commands,
  f: Files,
): PackageProfile {
  addMakeTargets(f, dir, commands);
  return { path: dir, ...base, commands: best(commands) };
}

/* ---------- Node ---------- */

const NODE_FRAMEWORKS: Record<string, string> = {
  next: "next",
  vite: "vite",
  react: "react",
  vue: "vue",
  svelte: "svelte",
  "@sveltejs/kit": "sveltekit",
  "@angular/core": "angular",
  express: "express",
  fastify: "fastify",
  "@nestjs/core": "nest",
  astro: "astro",
  "@remix-run/react": "remix",
  electron: "electron",
  "@tauri-apps/api": "tauri",
};
const NODE_TEST: Record<string, string> = {
  vitest: "vitest",
  jest: "jest",
  mocha: "mocha",
  "@playwright/test": "playwright",
  cypress: "cypress",
};
const SCRIPTS: Record<CommandKind, string[]> = {
  install: [],
  build: ["build"],
  lint: ["lint", "lint:check", "eslint"],
  format: ["format", "fmt", "prettier", "format:write"],
  typecheck: ["typecheck", "type-check", "check-types", "tsc", "types"],
  test: ["test", "test:unit", "tests"],
  dev: ["dev", "start", "serve"],
};

function nodePackageManager(f: Files, dir: string, pkg: Record<string, unknown> | null): [string, boolean] {
  const declared = (pkg?.packageManager ?? f.json("package.json")?.packageManager) as string | undefined;
  const lockfiles: [string, string][] = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ];
  // A monorepo keeps its lockfile at the root.
  for (const d of dir === "." ? ["."] : [dir, "."]) {
    for (const [file, pm] of lockfiles) if (f.exists(join(d, file))) return [pm, true];
  }
  const fromField = typeof declared === "string" ? /^(npm|pnpm|yarn|bun)@/.exec(declared)?.[1] : undefined;
  return [fromField ?? "npm", false];
}

function detectNode(f: Files, dir: string): PackageProfile {
  const pkg = f.json(join(dir, "package.json"));
  const [pm, locked] = nodePackageManager(f, dir, pkg);
  const deps = { ...(pkg?.dependencies as object), ...(pkg?.devDependencies as object) } as Record<string, string>;
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  // `bun test` is bun's own runner, not the script, so bun always goes through `bun run`.
  const run = (name: string) =>
    pm === "bun"
      ? `bun run ${name}`
      : name === "test"
        ? `${pm} test`
        : pm === "yarn"
          ? `yarn ${name}`
          : `${pm} run ${name}`;
  const exec = { npm: "npx", pnpm: "pnpm exec", yarn: "yarn", bun: "bunx" }[pm] ?? "npx";

  const commands: Commands = {};
  add(
    commands,
    "install",
    `${pm} install`,
    locked ? "lockfile" : "package.json",
    locked ? "high" : "medium",
    "convention",
  );
  for (const [kind, names] of Object.entries(SCRIPTS) as [CommandKind, string[]][]) {
    // npm init's placeholder test script fails on purpose; it is not a test command.
    const name = names.find((n) => typeof scripts[n] === "string" && !/no test specified/.test(scripts[n] ?? ""));
    if (name) add(commands, kind, run(name), `package.json#scripts.${name}`, "high", "script");
  }
  const has = (...names: string[]) => names.some((n) => f.exists(join(dir, n)));
  if (has("tsconfig.json")) add(commands, "typecheck", `${exec} tsc --noEmit`, "tsconfig.json", "medium", "convention");
  if (has("biome.json", "biome.jsonc")) {
    add(commands, "lint", `${exec} biome check .`, "biome.json", "medium", "convention");
    add(commands, "format", `${exec} biome format --write .`, "biome.json", "medium", "convention");
  }
  const eslint = f.files(dir).find((n) => /^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?)$/.test(n));
  if (eslint) add(commands, "lint", `${exec} eslint .`, eslint, "medium", "convention");
  const prettier = f.files(dir).find((n) => /^(\.prettierrc(\.\w+)?|prettier\.config\.[cm]?js)$/.test(n));
  if (prettier || pkg?.prettier)
    add(commands, "format", `${exec} prettier --write .`, prettier ?? "package.json#prettier", "medium", "convention");

  const testFrameworks = Object.entries(NODE_TEST)
    .filter(([dep]) => dep in deps)
    .map(([, name]) => name);
  if (/node --test/.test(scripts.test ?? "")) testFrameworks.push("node:test");
  return profile(
    dir,
    {
      ...(typeof pkg?.name === "string" ? { name: pkg.name } : {}),
      stack: "node",
      packageManager: pm,
      frameworks: Object.entries(NODE_FRAMEWORKS)
        .filter(([dep]) => dep in deps)
        .map(([, name]) => name),
      testFrameworks,
    },
    commands,
    f,
  );
}

/* ---------- Python ---------- */

const PY_FRAMEWORKS = ["django", "fastapi", "flask", "starlette", "streamlit", "litestar"];

function detectPython(f: Files, dir: string): PackageProfile {
  const pyproject = f.read(join(dir, "pyproject.toml")) ?? "";
  const s = tomlSections(pyproject);
  const projectBody = s.get("project");
  const deps = new Set([
    ...tomlDependencyNames(tomlArray(projectBody, "dependencies")),
    ...tomlDependencyNames(s.get("dependency-groups")),
    ...tomlDependencyNames(s.get("project.optional-dependencies")),
    ...[...s.entries()]
      .filter(([k]) => /^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/.test(k))
      .flatMap(([, body]) => tomlKeys(body)),
    ...f
      .files(dir)
      .filter((n) => /^requirements.*\.txt$/.test(n))
      .flatMap((n) => requirementNames(f.read(join(dir, n)) ?? "")),
  ]);

  const has = (...names: string[]) => names.some((n) => f.exists(join(dir, n)));
  const pm =
    has("uv.lock") || s.has("tool.uv")
      ? "uv"
      : has("poetry.lock") || s.has("tool.poetry")
        ? "poetry"
        : has("Pipfile")
          ? "pipenv"
          : "pip";
  const prefix = { uv: "uv run ", poetry: "poetry run ", pipenv: "pipenv run ", pip: "python -m " }[pm] ?? "";

  const commands: Commands = {};
  if (pm === "uv")
    add(commands, "install", "uv sync", has("uv.lock") ? "uv.lock" : "pyproject.toml", "high", "convention");
  else if (pm === "poetry") add(commands, "install", "poetry install", "pyproject.toml", "high", "convention");
  else if (pm === "pipenv") add(commands, "install", "pipenv install --dev", "Pipfile", "high", "convention");
  else if (has("requirements.txt"))
    add(commands, "install", "pip install -r requirements.txt", "requirements.txt", "medium", "convention");
  else if (pyproject) add(commands, "install", "pip install -e .", "pyproject.toml", "low", "convention");

  const pytestConfigured = s.has("tool.pytest.ini_options") || has("pytest.ini", "conftest.py");
  const testFrameworks: string[] = [];
  if (deps.has("pytest") || pytestConfigured) {
    testFrameworks.push("pytest");
    add(
      commands,
      "test",
      `${prefix}pytest`,
      deps.has("pytest") ? "dependency: pytest" : "pytest config",
      "high",
      "convention",
    );
  } else if (f.dirs(dir).includes("tests")) {
    add(commands, "test", `${prefix}pytest`, "tests/", "low", "convention");
  }
  if (s.has("tool.ruff") || has("ruff.toml", ".ruff.toml") || deps.has("ruff")) {
    add(
      commands,
      "lint",
      `${prefix}ruff check .`,
      s.has("tool.ruff") ? "pyproject.toml#tool.ruff" : "ruff",
      "high",
      "convention",
    );
    add(
      commands,
      "format",
      `${prefix}ruff format .`,
      s.has("tool.ruff") ? "pyproject.toml#tool.ruff" : "ruff",
      "high",
      "convention",
    );
  } else if (deps.has("flake8") || has(".flake8")) {
    add(commands, "lint", `${prefix}flake8`, "flake8", "medium", "convention");
  }
  if (deps.has("black") || s.has("tool.black"))
    add(commands, "format", `${prefix}black .`, "black", "medium", "convention");
  if (deps.has("mypy") || s.has("tool.mypy") || has("mypy.ini")) {
    add(commands, "typecheck", `${prefix}mypy .`, "mypy", "high", "convention");
  } else if (deps.has("pyright") || s.has("tool.pyright") || has("pyrightconfig.json")) {
    add(commands, "typecheck", `${prefix}pyright`, "pyright", "high", "convention");
  }
  if (deps.has("django") && has("manage.py")) {
    add(
      commands,
      "dev",
      `${prefix === "python -m " ? "" : prefix}python manage.py runserver`,
      "manage.py",
      "medium",
      "convention",
    );
  }
  if (s.has("build-system") && pm === "uv")
    add(commands, "build", "uv build", "pyproject.toml#build-system", "low", "convention");

  const name = tomlString(projectBody, "name") ?? tomlString(s.get("tool.poetry"), "name");
  return profile(
    dir,
    {
      ...(name ? { name } : {}),
      stack: "python",
      packageManager: pm,
      frameworks: PY_FRAMEWORKS.filter((fw) => deps.has(fw)),
      testFrameworks,
    },
    commands,
    f,
  );
}

/* ---------- Flutter / Dart, Go, Rust ---------- */

function detectDart(f: Files, dir: string): PackageProfile {
  const pubspec = f.read(join(dir, "pubspec.yaml")) ?? "";
  const flutter = /sdk:\s*flutter/.test(pubspec);
  const tool = flutter ? "flutter" : "dart";
  const hasTests = f.dirs(dir).includes("test");
  const commands: Commands = {};
  add(commands, "install", `${tool} pub get`, "pubspec.yaml", "high", "convention");
  add(commands, "test", `${tool} test`, hasTests ? "test/" : "pubspec.yaml", hasTests ? "high" : "low", "convention");
  add(commands, "lint", `${tool} analyze`, "pubspec.yaml", "high", "convention");
  add(commands, "format", "dart format .", "pubspec.yaml", "high", "convention");
  if (flutter) add(commands, "dev", "flutter run", "pubspec.yaml", "medium", "convention");
  const name = yamlScalar(pubspec, "name");
  return profile(
    dir,
    {
      ...(name ? { name } : {}),
      stack: flutter ? "flutter" : "dart",
      packageManager: "pub",
      frameworks: flutter ? ["flutter"] : [],
      testFrameworks: hasTests ? [flutter ? "flutter_test" : "package:test"] : [],
    },
    commands,
    f,
  );
}

const GO_FRAMEWORKS: Record<string, string> = {
  "github.com/gin-gonic/gin": "gin",
  "github.com/labstack/echo": "echo",
  "github.com/gofiber/fiber": "fiber",
  "github.com/go-chi/chi": "chi",
};

function detectGo(f: Files, dir: string): PackageProfile {
  const mod = f.read(join(dir, "go.mod")) ?? "";
  const commands: Commands = {};
  add(commands, "install", "go mod download", "go.mod", "high", "convention");
  add(commands, "build", "go build ./...", "go.mod", "high", "convention");
  add(commands, "test", "go test ./...", "go.mod", "high", "convention");
  const golangci = f.files(dir).find((n) => /^\.golangci\.(ya?ml|toml|json)$/.test(n));
  if (golangci) add(commands, "lint", "golangci-lint run", golangci, "high", "convention");
  else add(commands, "lint", "go vet ./...", "go.mod", "medium", "convention");
  add(commands, "format", "gofmt -w .", "go.mod", "high", "convention");
  const mainPkg = f
    .files(dir)
    .filter((n) => n.endsWith(".go") && !n.endsWith("_test.go"))
    .some((n) => /^package main\b/m.test(f.read(join(dir, n)) ?? ""));
  if (mainPkg) add(commands, "dev", "go run .", "package main", "medium", "convention");
  const name = /^module\s+(\S+)/m.exec(mod)?.[1];
  const hasTests = f.files(dir).some((n) => n.endsWith("_test.go"));
  return profile(
    dir,
    {
      ...(name ? { name } : {}),
      stack: "go",
      packageManager: "go",
      frameworks: Object.entries(GO_FRAMEWORKS)
        .filter(([m]) => mod.includes(m))
        .map(([, n]) => n),
      testFrameworks: hasTests ? ["go test"] : [],
    },
    commands,
    f,
  );
}

function detectRust(f: Files, dir: string): PackageProfile {
  const name = tomlString(tomlSections(f.read(join(dir, "Cargo.toml")) ?? "").get("package"), "name");
  const commands: Commands = {};
  add(commands, "build", "cargo build", "Cargo.toml", "high", "convention");
  add(commands, "test", "cargo test", "Cargo.toml", "high", "convention");
  add(commands, "lint", "cargo clippy", "Cargo.toml", "high", "convention");
  add(commands, "format", "cargo fmt", "Cargo.toml", "high", "convention");
  return profile(
    dir,
    {
      ...(name ? { name } : {}),
      stack: "rust",
      packageManager: "cargo",
      frameworks: [],
      testFrameworks: ["cargo test"],
    },
    commands,
    f,
  );
}
