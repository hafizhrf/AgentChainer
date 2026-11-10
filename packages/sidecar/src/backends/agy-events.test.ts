import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asTool, eventsOf, parseLine, usageOfResult, writesOf } from "./agy-events.ts";

// Lines shaped like the ones spike S8 recorded from `agy` 1.5.4 (paths shortened by hand).
const lines = [
  `{"event":"init","conversation_id":"conv-1","init":{"model":"gemini-3.8-flash-low","cwd":"C:\\\\w","permission_mode":"request-review"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"write_file","tool_info":{"name":"write_file","parameters":{"Path":"C:\\\\w\\\\hello.txt"}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":2,"state":"DONE","step_type":"tool","tool_name":"write_file","tool_info":{"name":"write_file","parameters":{"Path":"C:\\\\w\\\\hello.txt"}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"git status --short"}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":4,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"git status --short"},"error":{"type":"TOOL_ERROR","message":"permission check failed for command"}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":5,"state":"DONE","step_type":"agent_response","text_delta":"Done."}}`,
  `{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","response":"Done.","usage":{"input_tokens":23268,"output_tokens":154,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":23422},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}`,
];

describe("agy's stream as the app's events (M9-05)", () => {
  const events = lines.map(parseLine).filter((e) => e !== null);

  it("unwraps each line and finds the conversation's id", () => {
    assert.deepEqual(
      events.map((e) => e.kind),
      ["init", "step_update", "step_update", "step_update", "step_update", "step_update", "result"],
    );
    assert.ok(events.every((e) => e.conversationId === "conv-1"));
    assert.equal(parseLine("jetski: no output produced"), null);
  });

  it("names agy's tools as Claude's: a new file is a Write, a command a Bash", () => {
    assert.deepEqual(asTool({ name: "write_file", parameters: { Path: "a.ts" } }), {
      name: "Write",
      input: { file_path: "a.ts" },
      writes: "a.ts",
    });
    assert.deepEqual(asTool({ name: "replace_file_content", parameters: { TargetFile: "b.ts" } }).name, "Edit");
    assert.deepEqual(asTool({ name: "view_file", parameters: { AbsolutePath: "c.ts" } }), {
      name: "Read",
      input: { file_path: "c.ts" },
      writes: null,
    });
    assert.deepEqual(asTool({ name: "run_command", parameters: { CommandLine: "npm test" } }).input, {
      command: "npm test",
    });
  });

  it("turns a tool step into a start and an end, a refused command into an error, and text into deltas", () => {
    const out = events.flatMap(eventsOf);
    assert.deepEqual(
      out.map((e) =>
        e.type === "tool.started"
          ? `start ${e.toolUseId} ${e.name}`
          : e.type === "tool.completed"
            ? `end ${e.toolUseId} ${e.isError ? "error" : "ok"}`
            : e.type === "text.delta"
              ? `text ${e.text}`
              : e.type,
      ),
      ["start agy-2 Write", "end agy-2 ok", "start agy-4 Bash", "end agy-4 error", "text Done."],
    );
  });

  it("lists the files a turn wrote, and reads its tokens from the result", () => {
    assert.deepEqual(writesOf(events), [{ toolUseId: "agy-2", path: "C:\\w\\hello.txt" }]);
    assert.deepEqual(usageOfResult(events.find((e) => e.kind === "result")), {
      inputTokens: 23268,
      outputTokens: 154,
      thinkingTokens: 0,
      cacheReadTokens: 0,
    });
  });
});
