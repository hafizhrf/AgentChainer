// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${NAME}` references are what the CLI receives, written literally.
import assert from "node:assert/strict";
import { test } from "node:test";
import { shellLine } from "./mcpCommand.ts";

test("shows a command as it would be pasted, quoting what a shell would read (CP-02)", () => {
  assert.equal(
    shellLine(["claude", "mcp", "add", "--scope", "local", "files", "--env", "ROOT=${ROOT}", "--", "npx", "/my dir"]),
    "claude mcp add --scope local files --env 'ROOT=${ROOT}' -- npx '/my dir'",
  );
  assert.equal(shellLine(["echo", "it's"]), `echo 'it'\\''s'`);
  assert.equal(
    shellLine(["https://mcp.example.com/mcp?x=1", "Authorization: Bearer ${T}"]),
    "'https://mcp.example.com/mcp?x=1' 'Authorization: Bearer ${T}'",
  );
});
