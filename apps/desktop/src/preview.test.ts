import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localUrl, localUrls, previewUrls } from "./preview.ts";
import type { Item } from "./transcript.ts";

describe("local addresses for the preview (UX-22)", () => {
  it("takes only this machine's http(s) addresses", () => {
    assert.equal(localUrl("http://localhost:5173/"), "http://localhost:5173/");
    assert.equal(localUrl("http://127.0.0.1:8000/docs"), "http://127.0.0.1:8000/docs");
    assert.equal(localUrl("http://[::1]:3000"), "http://[::1]:3000/");
    assert.equal(localUrl("http://0.0.0.0:4321"), "http://localhost:4321/", "0.0.0.0 is opened as localhost");
    assert.equal(localUrl("https://example.com"), null);
    assert.equal(localUrl("http://localhost.example.com:80"), null);
    assert.equal(localUrl("http://user:pw@localhost:3000"), null);
    assert.equal(localUrl("file:///C:/x.html"), null);
    assert.equal(localUrl("javascript:alert(1)"), null);
    assert.equal(localUrl("not a url"), null);
  });

  it("finds them in a dev server's output, colours and punctuation aside", () => {
    const vite =
      "\u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m";
    assert.deepEqual(localUrls(vite), ["http://localhost:5173/"]);
    assert.deepEqual(localUrls("Listening on http://127.0.0.1:8000. Press Ctrl+C."), ["http://127.0.0.1:8000/"]);
    assert.deepEqual(
      localUrls("ready - started server on 0.0.0.0:3000, url: http://localhost:3000 (http://localhost:3000)"),
      ["http://localhost:3000/"],
    );
    assert.deepEqual(localUrls("Network: http://192.168.1.4:5173/ and https://vitejs.dev"), []);
  });

  it("lists the chat's latest first, each once", () => {
    const tool = (id: string, output: string): Item => ({
      kind: "tool",
      id,
      name: "Bash",
      input: {},
      status: "done",
      output,
    });
    const items: Item[] = [
      tool("1", "Local: http://localhost:5173/"),
      { kind: "assistant", id: 1, text: "see http://localhost:9999", open: false },
      tool("2", "Server running at http://127.0.0.1:8000"),
      tool("3", "Local: http://localhost:5173/"),
    ];
    assert.deepEqual(previewUrls(items), ["http://localhost:5173/", "http://127.0.0.1:8000/"]);
  });
});
