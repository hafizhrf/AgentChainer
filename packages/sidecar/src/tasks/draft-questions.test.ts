import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PermissionRequest } from "@agentchainer/protocol";
import { DraftQuestions } from "./draft-questions.ts";

const tag = { id: "2026-11-11-0a1b2c3d", cwd: "/w", stepId: "draft", label: "Drafting the contract", role: "planner" };
const input = { questions: [{ question: "Which discounts?", header: "Discounts", options: [] }] };

function questions() {
  const sent: PermissionRequest[] = [];
  return { q: new DraftQuestions((r) => sent.push(r)), sent };
}

describe("a drafter's questions waiting for the person (UX-24)", () => {
  it("sends a question card tagged with the draft step, and resolves with the answers", async () => {
    const { q, sent } = questions();
    const asked = q.ask("draft-x-1", tag, input);
    assert.equal(sent.length, 1);
    const [card] = sent;
    assert.deepEqual([card?.toolName, card?.sessionId, card?.task?.stepId], ["AskUserQuestion", "draft-x-1", "draft"]);
    assert.equal(q.waiting, 1);
    assert.equal(
      q.respond(card?.requestId ?? "", true, { ...input, answers: { "Which discounts?": "Percent off" } }),
      true,
    );
    assert.deepEqual(await asked, { "Which discounts?": "Percent off" });
    assert.equal(q.waiting, 0);
  });

  it("resolves with nothing on Skip, on an answer with no answers, and when the draft stops", async () => {
    const { q, sent } = questions();
    const skipped = q.ask("s", tag, input);
    q.respond(sent[0]?.requestId ?? "", false);
    assert.equal(await skipped, null);

    const empty = q.ask("s", tag, input);
    q.respond(sent[1]?.requestId ?? "", true, { ...input, answers: { "Which discounts?": "  " } });
    assert.equal(await empty, null);

    const stop = new AbortController();
    const stopped = q.ask("s", tag, input, stop.signal);
    stop.abort();
    assert.equal(await stopped, null);
    assert.equal(q.waiting, 0);
    // A stopped draft asks nothing.
    assert.equal(await q.ask("s", tag, input, stop.signal), null);
    assert.equal(sent.length, 3);
  });

  it("isn't the answer to a question it didn't ask", () => {
    assert.equal(questions().q.respond("someone-else", true, {}), false);
  });
});
