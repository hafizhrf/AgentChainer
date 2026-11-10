import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { probe, probeTarget } from "./preview.ts";

describe("the preview's server probe (UX-22)", () => {
  it("tries only this machine's addresses", () => {
    assert.deepEqual(probeTarget("http://localhost:5173/"), { host: "localhost", port: 5173 });
    assert.deepEqual(probeTarget("http://[::1]:3000"), { host: "::1", port: 3000 });
    assert.deepEqual(probeTarget("http://0.0.0.0:8080"), { host: "127.0.0.1", port: 8080 });
    assert.deepEqual(probeTarget("https://127.0.0.1"), { host: "127.0.0.1", port: 443 });
    for (const url of ["http://example.com", "http://192.168.1.4:5173", "ftp://localhost:21", "nonsense"]) {
      assert.throws(() => probeTarget(url), /this machine/, url);
    }
  });

  it("says a listening server is up, and a closed port isn't", async () => {
    const server = createServer((s) => s.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    assert.deepEqual(await probe(`http://127.0.0.1:${port}/`), { up: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.deepEqual(await probe(`http://127.0.0.1:${port}/`, 500), { up: false });
  });
});
