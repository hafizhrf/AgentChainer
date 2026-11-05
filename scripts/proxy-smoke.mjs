// X-14: the packaged sidecar behind an HTTP proxy. The Rust core starts it with NODE_USE_ENV_PROXY=1 (spike S1), so
// its downloads follow HTTPS_PROXY / HTTP_PROXY / NO_PROXY like other tools. This starts a small CONNECT proxy on
// localhost that records where it tunnels to, then runs the sidecar's first-run SDK download three times, each with an
// empty data dir:
//   1. through the proxy: the download succeeds, and the proxy saw registry.npmjs.org;
//   2. through a proxy that isn't there: the download fails, so nothing goes around the proxy;
//   3. the same dead proxy, with NO_PROXY naming the registry: the download succeeds directly.
// No Claude login needed. Runs in CI on macOS, Windows and Ubuntu.
//
// Usage: node scripts/proxy-smoke.mjs [path to sidecar executable]
//        (default: the one build:sea wrote to apps/desktop/src-tauri/binaries/)
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PROTOCOL_VERSION } from "../packages/protocol/src/index.ts";

const binDir = resolve("apps/desktop/src-tauri/binaries");
const bin =
  process.argv[2] ?? join(binDir, readdirSync(binDir).find((f) => f.startsWith("agentchainer-sidecar-")) ?? "");
const REGISTRY = "registry.npmjs.org";

/** An HTTP proxy that only tunnels (CONNECT), as HTTPS through a proxy does, and remembers each host:port. */
function startProxy() {
  const tunnels = [];
  const server = createServer((_req, res) => res.writeHead(405).end());
  server.on("connect", (req, client, head) => {
    tunnels.push(req.url);
    const [host, port] = (req.url ?? "").split(":");
    const upstream = connect(Number(port) || 443, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on("error", close);
    client.on("error", close);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, tunnels, port: server.address().port })));
}

/** A port nothing listens on: bound, then released. */
function deadPort() {
  return new Promise((ok) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** Starts the sidecar with `env`, sends system.hello then sdk.prepare, and returns sdk.prepare's result or error. */
function prepare(env) {
  const dataDir = mkdtempSync(join(tmpdir(), "ac-proxy-smoke-"));
  // The proxy variables are set here only: none from this machine may leak in.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?|all|no)_proxy$/i.test(k)));
  return new Promise((done) => {
    const child = spawn(bin, [], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...base, ...env, AGENTCHAINER_DATA_DIR: dataDir, NODE_USE_ENV_PROXY: "1" },
    });
    const finish = (outcome) => {
      child.kill();
      rmSync(dataDir, { recursive: true, force: true });
      done(outcome);
    };
    let id = 0;
    const send = (method, params) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })}\n`);
    createInterface({ input: child.stdout }).on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.id === 1) {
        if (frame.error) return finish({ error: frame.error.message });
        send("sdk.prepare", {});
      } else if (frame.id === 2) {
        finish(frame.error ? { error: frame.error.message } : { result: frame.result });
      }
    });
    child.on("error", (err) => finish({ error: String(err) }));
    send("system.hello", { protocolVersion: PROTOCOL_VERSION });
  });
}

// A hung sidecar fails the check instead of the whole CI job.
setTimeout(() => {
  console.error("FAIL: no answer within 5 minutes");
  process.exit(1);
}, 300_000).unref();

const problems = [];
const proxy = await startProxy();
try {
  console.log(`sidecar: ${bin}`);
  const via = `http://127.0.0.1:${proxy.port}`;
  const through = await prepare({ HTTPS_PROXY: via, HTTP_PROXY: via });
  console.log(`1. through the proxy: ${JSON.stringify(through).slice(0, 120)}; tunnels: ${proxy.tunnels.join(", ")}`);
  if (through.result?.source !== "download") problems.push("the download through the proxy didn't succeed");
  if (!proxy.tunnels.some((t) => t.startsWith(`${REGISTRY}:`))) problems.push(`the proxy never saw ${REGISTRY}`);

  const dead = `http://127.0.0.1:${await deadPort()}`;
  const blocked = await prepare({ HTTPS_PROXY: dead, HTTP_PROXY: dead });
  console.log(`2. a proxy that isn't there: ${JSON.stringify(blocked).slice(0, 160)}`);
  if (!blocked.error?.includes("proxy")) problems.push("with a dead proxy the download didn't fail as it should");

  const bypass = await prepare({ HTTPS_PROXY: dead, HTTP_PROXY: dead, NO_PROXY: REGISTRY });
  console.log(`3. NO_PROXY=${REGISTRY}: ${JSON.stringify(bypass).slice(0, 120)}`);
  if (bypass.result?.source !== "download") problems.push("NO_PROXY didn't let the registry through directly");
} finally {
  proxy.server.close();
}

if (problems.length) {
  console.error(`FAIL: ${problems.join("; ")}`);
  process.exit(1);
}
console.log("OK: the SDK download follows HTTPS_PROXY, fails without a working proxy, and honours NO_PROXY");
process.exit(0);
