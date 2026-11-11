// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${NAME}` references are what the CLI receives, written literally.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { RpcErrorCode } from "@agentchainer/protocol";
import { listRuns, rollback } from "./bootstrap/apply.ts";
import { fakeCli, ok } from "./bootstrap/fake-cli.ts";
import type { CliResult, McpAddSpec, McpCli } from "./installer.ts";
import {
  addServer,
  addSpec,
  listServers,
  parseGet,
  parseList,
  removeServer,
  serverDetails,
  splitCommand,
} from "./mcp.ts";
import { RpcFailure } from "./rpc.ts";

// CP-02: the MCP servers page. The CLI's text below follows what `claude mcp list` and `claude mcp get` printed in
// 2.1.293, written by hand with made-up names, paths and values.

const LIST = `Checking MCP server health…

claude.ai Example Docs: https://docs.example.com/mcp - ✔ Connected
claude.ai Example Chat: https://chat.example.com/mcp - ! Needs authentication
plugin:demo:search: npx -y demo-search - ✔ Connected
files: npx -y @modelcontextprotocol/server-filesystem /work/project - ✔ Connected
tracker: node /opt/tools/tracker.mjs --token ghp_abcdefghijklmnopqrstuvwxyz0123 - ✔ Connected
shared: node /opt/tools/shared.mjs - ⏸ Pending approval (run \`claude\` to approve)
broken: node /nonexistent/x.mjs - ✘ Failed to connect — CONNECTION_CLOSED: Connection closed
docs: https://mcp.example.com/mcp (HTTP) - ✘ Failed to connect — HTTP 405: Error POSTing to endpoint: <!doctype html><html lang="en"><head><title>Example</title></head><body>${"x".repeat(600)}</body></html>
events: http://127.0.0.1:9/sse (SSE) - ✘ Failed to connect — SSE error: ECONNREFUSED
bare: /usr/local/bin/bare  - ✔ Connected

MCP config diagnostics ⚠

For help configuring MCP servers, see: https://code.claude.com/docs/en/mcp

[Contains warnings] Project config (shared via .mcp.json)
Location: /work/project/.mcp.json
 └ [Warning] [shared] mcpServers.shared: Missing environment variables: SHARED_TOKEN

[Contains warnings] Local config (private to you in this project)
Location: /home/someone/.claude.json [project: /work/project]
 ├ [Warning] [broken] mcpServers.broken: Missing environment variables: BROKEN_KEY
 └ [Warning] [docs] mcpServers.docs: Missing environment variables: DOCS_TOKEN
`;

const GET_STDIO = `files:
  Scope: Local config (private to you in this project)
  Status: ✘ Failed to connect
  Issue: CONNECTION_CLOSED: Connection closed
  Type: stdio
  Command: npx
  Args: -y @modelcontextprotocol/server-filesystem /work/project
  Environment:
    ROOT_DIR=/work/project
    FILES_TOKEN=very-secret-value-1

To remove this server, run: claude mcp remove files -s local
`;

const GET_HTTP = `docs:
  Scope: Project config (shared via .mcp.json)
  Status: ✔ Connected
  Type: http
  URL: https://mcp.example.com/mcp
  Headers:
    Authorization: Bearer very-secret-value-2
    X-Team: platform

To remove this server, run: claude mcp remove docs -s project
`;

const GET_CONNECTOR = `claude.ai Example Chat:
  Scope: claude.ai config
  Status: ! Needs authentication
`;

const roots: string[] = [];
const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), "ac-mcp-"));
  roots.push(root);
  return root;
};
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const failed = (stderr: string): CliResult => ({ ok: false, status: 1, json: null, stdout: "", stderr });

/** A stand-in for the user's CLI that edits `.mcp.json` the way `claude mcp add/remove --scope project` do. */
function fakeMcpCli(root: string, opts: { addFails?: string } = {}) {
  const calls: string[] = [];
  const file = join(root, ".mcp.json");
  const edit = (fn: (servers: Record<string, unknown>) => void) => {
    const json = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { mcpServers: {} };
    fn(json.mcpServers);
    writeFileSync(file, JSON.stringify(json, null, 2));
  };
  const cli: McpCli = {
    list: async () => {
      calls.push("list");
      return { ...ok(), stdout: LIST };
    },
    get: async (name) => {
      calls.push(`get ${name}`);
      return name === "files" ? { ...ok(), stdout: GET_STDIO } : failed(`No MCP server named "${name}".`);
    },
    add: async (spec: McpAddSpec) => {
      calls.push(`add ${spec.scope} ${spec.name}`);
      if (opts.addFails) return failed(opts.addFails);
      if (spec.scope === "project") edit((s) => Object.assign(s, { [spec.name]: { command: spec.argv[0] } }));
      return ok();
    },
    remove: async (name, scope) => {
      calls.push(`remove ${scope} ${name}`);
      if (scope === "project") edit((s) => delete s[name]);
      return ok();
    },
  };
  return { cli, calls };
}

const rejects = (fn: () => unknown, pattern: RegExp) =>
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof RpcFailure, String(err));
    assert.equal(err.code, RpcErrorCode.invalidParams);
    assert.match(err.message, pattern);
    return true;
  });

describe("reading the CLI's MCP output (CP-02)", () => {
  it("lists every server with its status, transport and owner, and attaches the diagnostics' warnings", () => {
    const servers = parseList(LIST);
    assert.deepEqual(
      servers.map((s) => [s.name, s.status, s.transport, s.managedBy ?? "-"]),
      [
        ["claude.ai Example Docs", "connected", "http", "claudeai"],
        ["claude.ai Example Chat", "needsAuth", "http", "claudeai"],
        ["plugin:demo:search", "connected", "stdio", "plugin"],
        ["files", "connected", "stdio", "-"],
        ["tracker", "connected", "stdio", "-"],
        ["shared", "pending", "stdio", "-"],
        ["broken", "failed", "stdio", "-"],
        ["docs", "failed", "http", "-"],
        ["events", "failed", "sse", "-"],
        ["bare", "connected", "stdio", "-"],
      ],
    );
    const by = new Map(servers.map((s) => [s.name, s]));
    assert.equal(by.get("files")?.target, "npx -y @modelcontextprotocol/server-filesystem /work/project");
    assert.equal(by.get("docs")?.target, "https://mcp.example.com/mcp");
    assert.equal(by.get("bare")?.target, "/usr/local/bin/bare");
    assert.equal(by.get("broken")?.statusText, "Failed to connect — CONNECTION_CLOSED: Connection closed");
    assert.equal(by.get("shared")?.statusText, "Pending approval (run `claude` to approve)");
    assert.deepEqual(by.get("shared")?.warnings, ["Missing environment variables: SHARED_TOKEN"]);
    assert.deepEqual(by.get("docs")?.warnings, ["Missing environment variables: DOCS_TOKEN"]);
    assert.deepEqual(by.get("files")?.warnings, []);
  });

  it("masks a token in a target and cuts a long status short", () => {
    const servers = parseList(LIST);
    const tracker = servers.find((s) => s.name === "tracker");
    assert.ok(tracker && !tracker.target.includes("ghp_"), tracker?.target);
    const docs = servers.find((s) => s.name === "docs");
    assert.ok(docs && docs.statusText.length <= 300 && docs.statusText.endsWith("…"));
  });

  it("reads nothing from an empty list", () => {
    assert.deepEqual(parseList("No MCP servers configured. Use `claude mcp add` to add a server.\n"), []);
  });

  it("keeps a server's variable and header names, never their values", () => {
    const stdio = parseGet(GET_STDIO);
    assert.deepEqual(stdio, {
      name: "files",
      target: "npx -y @modelcontextprotocol/server-filesystem /work/project",
      transport: "stdio",
      status: "failed",
      statusText: "Failed to connect — CONNECTION_CLOSED: Connection closed",
      warnings: [],
      scope: "local",
      scopeText: "Local config (private to you in this project)",
      env: ["ROOT_DIR", "FILES_TOKEN"],
      headers: [],
    });
    const http = parseGet(GET_HTTP);
    assert.equal(http?.scope, "project");
    assert.equal(http?.transport, "http");
    assert.equal(http?.target, "https://mcp.example.com/mcp");
    assert.deepEqual(http?.headers, ["Authorization", "X-Team"]);
    const shown = JSON.stringify([stdio, http]);
    for (const value of ["very-secret-value-1", "very-secret-value-2", "platform", "ROOT_DIR="]) {
      assert.ok(!shown.includes(value), `${value} leaked`);
    }
  });

  it("reads a claude.ai connector as managed elsewhere, and refuses text it can't read", () => {
    const c = parseGet(GET_CONNECTOR);
    assert.equal(c?.scope, "other");
    assert.equal(c?.managedBy, "claudeai");
    assert.equal(c?.status, "needsAuth");
    assert.equal(parseGet('No MCP server named "x".\n'), null);
  });
});

describe("splitting a command line", () => {
  it("keeps quoted words together, without a shell", () => {
    assert.deepEqual(splitCommand(`npx -y @scope/server "/my dir" 'it''s' a\\ b`), [
      "npx",
      "-y",
      "@scope/server",
      "/my dir",
      "its",
      "a b",
    ]);
    assert.deepEqual(splitCommand(`echo "say \\"hi\\"" $HOME;rm`), ["echo", 'say "hi"', "$HOME;rm"]);
  });

  it("keeps a Windows path's backslashes, and refuses an open quote", () => {
    assert.deepEqual(splitCommand(String.raw`C:\tools\server.exe --root C:\work`), [
      String.raw`C:\tools\server.exe`,
      "--root",
      String.raw`C:\work`,
    ]);
    assert.equal(splitCommand(`node "server.js`), null);
    assert.deepEqual(splitCommand("   "), []);
  });
});

describe("checking an add", () => {
  const base = { cwd: "/w", name: "files", scope: "local" as const };

  it("passes variables by reference, as the CLI's arguments", () => {
    const spec = addSpec({
      ...base,
      transport: "stdio",
      command: `npx -y @modelcontextprotocol/server-filesystem "/work/my project"`,
      env: ["ROOT_DIR", " ROOT_DIR ", "API_KEY"],
    });
    assert.deepEqual(spec.argv, ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/work/my project"]);
    assert.deepEqual(spec.env, ["ROOT_DIR=${ROOT_DIR}", "API_KEY=${API_KEY}"]);
  });

  it("allows a header that refers to a variable, and https or a local http URL", () => {
    const spec = addSpec({
      ...base,
      transport: "http",
      url: "https://mcp.example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer ${EXAMPLE_TOKEN}" }],
    });
    assert.equal(spec.url, "https://mcp.example.com/mcp");
    assert.deepEqual(spec.headers, ["Authorization: Bearer ${EXAMPLE_TOKEN}"]);
    assert.equal(
      addSpec({ ...base, transport: "sse", url: "http://localhost:8080/sse" }).url,
      "http://localhost:8080/sse",
    );
  });

  it("refuses anything secret, and anything the CLI would read wrong", () => {
    const stdio = { ...base, transport: "stdio" as const };
    const http = { ...base, transport: "http" as const, url: "https://mcp.example.com/mcp" };
    rejects(() => addSpec({ ...stdio, command: "" }), /command that starts/);
    rejects(() => addSpec({ ...stdio, command: `node "x.js` }), /quote/);
    rejects(() => addSpec({ ...stdio, command: "node s.js --api-key=abcdef123456" }), /key or token/);
    rejects(() => addSpec({ ...stdio, command: "node s.js ghp_abcdefghijklmnopqrstuvwxyz0123" }), /key or token/);
    rejects(() => addSpec({ ...stdio, command: "node s.js", env: ["1BAD"] }), /environment variable name/);
    rejects(() => addSpec({ ...stdio, command: "node s.js", headers: [{ name: "X", value: "${X}" }] }), /Headers/);
    rejects(() => addSpec({ ...http, env: ["TOKEN"] }), /Environment variables go/);
    rejects(() => addSpec({ ...http, url: "http://mcp.example.com/mcp" }), /https/);
    rejects(() => addSpec({ ...http, url: "ftp://mcp.example.com" }), /full URL/);
    rejects(() => addSpec({ ...http, url: "not a url" }), /full URL/);
    rejects(() => addSpec({ ...http, url: "https://user:pass@mcp.example.com/mcp" }), /password/);
    rejects(() => addSpec({ ...http, url: "https://mcp.example.com/mcp?api_key=abcdef123456" }), /password/);
    rejects(() => addSpec({ ...http, headers: [{ name: "Authorization", value: "Bearer abc123" }] }), /refer to/);
    rejects(() => addSpec({ ...http, headers: [{ name: "X-Team", value: "platform" }] }), /refer to/);
    rejects(() => addSpec({ ...http, headers: [{ name: "Bad Name", value: "${X}" }] }), /header name/);
  });
});

describe("the MCP servers page's changes (CP-02)", () => {
  const params = (scope: "local" | "project" | "user") => ({
    cwd: "/w",
    name: "files",
    scope,
    transport: "stdio" as const,
    command: "npx -y @modelcontextprotocol/server-filesystem /work",
    env: ["ROOT_DIR"],
  });

  it("shows the command without running it", async () => {
    const root = workspace();
    const { cli, calls } = fakeMcpCli(root);
    const r = await addServer(root, cli, { ...params("local"), dryRun: true }, "test");
    assert.deepEqual(r, {
      command: [
        "claude",
        "mcp",
        "add",
        "--scope",
        "local",
        "files",
        "--env",
        "ROOT_DIR=${ROOT_DIR}",
        "--",
        "npx",
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/work",
      ],
    });
    assert.deepEqual(calls, []);
    assert.equal(listRuns(root).length, 0);
  });

  it("records an add as a History run that Roll back removes, putting .mcp.json back", async () => {
    const root = workspace();
    const { cli } = fakeMcpCli(root);
    const r = await addServer(root, cli, params("project"), "test");
    assert.ok(r.runId);
    assert.ok(existsSync(join(root, ".mcp.json")));
    const [run] = listRuns(root);
    assert.equal(run?.actions[0]?.title, "Add MCP server files");
    assert.deepEqual(run?.actions[0]?.undo, [{ type: "mcp", name: "files", scope: "project" }]);

    const sync = fakeCli(root);
    const results = rollback(root, run?.runId ?? "", { cli: sync });
    assert.deepEqual(results, [{ id: "mcp:files", status: "rolled-back" }]);
    assert.deepEqual(sync.calls, ["mcp remove project files"]);
    assert.equal(existsSync(join(root, ".mcp.json")), false);
  });

  it("removes through the CLI, restores .mcp.json and shows the run rolled back", async () => {
    const root = workspace();
    const { cli, calls } = fakeMcpCli(root);
    await addServer(root, cli, params("project"), "test");
    await removeServer(root, cli, "files", "project");
    assert.deepEqual(calls, ["add project files", "remove project files"]);
    assert.equal(existsSync(join(root, ".mcp.json")), false);
    assert.equal(listRuns(root)[0]?.actions[0]?.status, "rolled-back");
  });

  it("leaves no run behind when the CLI refuses, and masks what it said", async () => {
    const root = workspace();
    const { cli } = fakeMcpCli(root, { addFails: "Bad config near sk-ant-abcdefghijklmnop" });
    await assert.rejects(addServer(root, cli, params("local"), "test"), (err: Error) => {
      assert.match(err.message, /claude mcp add failed/);
      assert.ok(!err.message.includes("sk-ant-abcdefghijklmnop"), err.message);
      return true;
    });
    assert.equal(listRuns(root).length, 0);
  });

  it("keeps the listing for the session, and a check updates its status", async () => {
    const root = workspace();
    const { cli, calls } = fakeMcpCli(root);
    const first = await listServers(root, cli);
    assert.equal(first.servers.find((s) => s.name === "files")?.status, "connected");
    await listServers(root, cli);
    assert.deepEqual(calls, ["list"]);
    const d = await serverDetails(root, cli, "files");
    assert.equal(d.status, "failed");
    assert.equal((await listServers(root, cli)).servers.find((s) => s.name === "files")?.status, "failed");
    await listServers(root, cli, true);
    assert.deepEqual(calls, ["list", "get files", "list"]);
    await assert.rejects(serverDetails(root, cli, "nope"), /claude mcp get failed/);
  });

  it("shows an added server at once, unchecked", async () => {
    const root = workspace();
    const { cli } = fakeMcpCli(root);
    await listServers(root, cli);
    await addServer(root, cli, { ...params("local"), name: "fresh" }, "test");
    const fresh = (await listServers(root, cli)).servers.find((s) => s.name === "fresh");
    assert.equal(fresh?.status, "unknown");
    assert.equal(fresh?.target, "npx -y @modelcontextprotocol/server-filesystem /work");
  });
});
