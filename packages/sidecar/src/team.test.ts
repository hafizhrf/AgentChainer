import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "@agentchainer/protocol";
import type { AgentSdkModule } from "./sdk-loader.ts";
import type { TurnResult } from "./session.ts";
import {
  type Handoff,
  MAX_WORKERS,
  type Member,
  TEAM_INSTRUCTIONS,
  Team,
  TeamError,
  teamInstructions,
  teamTools,
  type WorkerSpec,
} from "./team.ts";

/** A stand-in session: turns run until the test ends them with `finish`. */
class FakeMember implements Member {
  readonly id: string;
  costUsd = 0;
  sent: string[] = [];
  injected: string[] = [];
  open = 0;
  closed = false;
  on: { turnEnded(r: TurnResult): void; ended(): void } | undefined;
  constructor(id: string) {
    this.id = id;
  }
  get idle(): boolean {
    return this.open === 0 && !this.closed;
  }
  send(text: string): string {
    this.sent.push(text);
    this.open++;
    return `m${this.sent.length}`;
  }
  inject(text: string): boolean {
    if (this.open === 0) return false;
    this.injected.push(text);
    return true;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.on?.ended();
  }
  finish(text: string, costUsd = 0.1, isError = false): void {
    this.open--;
    this.costUsd += costUsd;
    this.on?.turnEnded({
      subtype: isError ? "error_during_execution" : "success",
      isError,
      text: isError ? "" : text,
      costUsd,
    });
  }
}

function setup(capUsd = 5) {
  const events: AgentEvent[] = [];
  const specs: WorkerSpec[] = [];
  const workers: FakeMember[] = [];
  const team = new Team(capUsd, {
    emit: (e) => void events.push(e),
    open: (spec, on) => {
      specs.push(spec);
      const m = new FakeMember(`w${workers.length + 1}`);
      m.on = on;
      workers.push(m);
      return m;
    },
  });
  const supervisor = new FakeMember("sup");
  team.attach(supervisor);
  return { team, events, specs, workers, supervisor };
}

describe("Team (M8-03)", () => {
  it("assigns a read worker by default, and delivers its report once the supervisor is idle", async () => {
    const { team, specs, workers, supervisor, events } = setup();
    supervisor.send("plan the work"); // the supervisor's turn, in which it calls assign
    const r = await team.assign({ name: "scan", prompt: "count files" }, false);
    assert.deepEqual(r, { workerId: "w1" });
    assert.deepEqual(specs, [{ name: "scan", access: "read", maxBudgetUsd: 5 }]);
    assert.deepEqual(workers[0]?.sent, ["count files"]);

    workers[0]?.finish("12 files");
    assert.equal(supervisor.sent.length, 1, "not delivered while the supervisor's turn runs");
    supervisor.open--;
    team.supervisorTurnEnded();
    assert.equal(supervisor.sent[1], '[From worker "scan" (w1)]\n12 files');
    assert.deepEqual(
      events.filter((e) => e.type === "worker.message"),
      [{ type: "worker.message", workerId: "w1", name: "scan", text: "12 files", isError: false }],
    );
    assert.deepEqual(team.readInbox(), [], "a delivered report isn't in the inbox again");
  });

  it("delivers reports that wait together in one message", async () => {
    const { team, workers, supervisor } = setup();
    supervisor.send("go");
    await team.assign({ name: "a", prompt: "x" }, false);
    await team.assign({ name: "b", prompt: "y", access: "write" }, false);
    workers[0]?.finish("A");
    workers[1]?.finish("B");
    supervisor.open--;
    team.supervisorTurnEnded();
    assert.equal(supervisor.sent[1], '[From worker "a" (w1)]\nA\n\n[From worker "b" (w2)]\nB');
  });

  it("delivers at once when the supervisor is idle", async () => {
    const { team, workers, supervisor } = setup();
    await team.assign({ name: "a", prompt: "x" }, false);
    workers[0]?.finish("done");
    assert.deepEqual(supervisor.sent, ['[From worker "a" (w1)]\ndone']);
  });

  it("hands off: waits for the report and returns it, not through the inbox", async () => {
    const { team, workers, supervisor } = setup();
    supervisor.send("go");
    const answer = team.assign({ name: "a", prompt: "x", budgetUsd: 1 }, true);
    await Promise.resolve();
    workers[0]?.finish("the answer", 0.2);
    const r = (await answer) as Handoff;
    assert.deepEqual(r, { workerId: "w1", text: "the answer", isError: false, costUsd: 0.2 });
    assert.deepEqual(team.readInbox(), []);
    assert.equal(supervisor.sent.length, 1);
  });

  it("gives a reused worker more work only when it's idle", async () => {
    const { team, workers } = setup();
    await team.assign({ name: "a", prompt: "x" }, false);
    await assert.rejects(team.assign({ name: "a", prompt: "y", worker: "w1" }, false), /busy; use send_message/);
    workers[0]?.finish("one");
    assert.deepEqual(await team.assign({ name: "a", prompt: "y", worker: "w1" }, false), { workerId: "w1" });
    assert.equal(workers.length, 1);
    assert.deepEqual(workers[0]?.sent, ["x", "y"]);
  });

  it("sends a message into a running turn, or starts one", async () => {
    const { team, workers } = setup();
    await team.assign({ name: "a", prompt: "x" }, false);
    assert.deepEqual(team.message("w1", "also check tests"), { delivered: "into_turn" });
    workers[0]?.finish("one");
    assert.deepEqual(team.message("w1", "now docs"), { delivered: "new_turn" });
    assert.deepEqual(workers[0]?.injected, ["also check tests"]);
    assert.deepEqual(workers[0]?.sent, ["x", "now docs"]);
    assert.throws(() => team.message("nope", "hi"), TeamError);
  });

  it(`keeps at most ${MAX_WORKERS} workers open; closing one frees its place`, async () => {
    const { team } = setup();
    for (let i = 0; i < MAX_WORKERS; i++) await team.assign({ name: `w${i}`, prompt: "x" }, false);
    await assert.rejects(team.assign({ name: "more", prompt: "x" }, false), /close one with close_worker/);
    await team.closeWorker("w1");
    assert.equal(team.list().find((w) => w.workerId === "w1")?.status, "ended");
    await team.assign({ name: "more", prompt: "x" }, false);
    assert.throws(() => team.message("w1", "hi"), /has ended/);
  });

  it("caps each worker at what's left of the shared budget", async () => {
    const { team, specs, workers, supervisor } = setup(1);
    supervisor.costUsd = 0.3;
    await team.assign({ name: "a", prompt: "x", budgetUsd: 5 }, false);
    workers[0]?.finish("a", 0.4);
    await team.assign({ name: "b", prompt: "y", budgetUsd: 0.1 }, false);
    assert.deepEqual(
      specs.map((s) => Math.round(s.maxBudgetUsd * 100)),
      [70, 10],
    );
  });

  it("stops the team at the cap: closes the workers, refuses more work, delivers nothing", async () => {
    const { team, workers, supervisor, events } = setup(1);
    supervisor.send("go");
    await team.assign({ name: "a", prompt: "x" }, false);
    await team.assign({ name: "b", prompt: "y" }, false);
    const waiting = team.assign({ name: "c", prompt: "z" }, true);
    await Promise.resolve();
    workers[0]?.finish("a", 1.2);
    assert.equal(workers[1]?.closed, true);
    assert.deepEqual(await waiting, {
      workerId: "w3",
      text: "The worker's session ended first.",
      isError: true,
      costUsd: 0,
    });
    assert.deepEqual(events.at(-1), { type: "team.budget", spentUsd: 1.2, capUsd: 1, stopped: true });
    supervisor.open--;
    team.supervisorTurnEnded();
    assert.equal(supervisor.sent.length, 1, "no report goes out once the cap is reached");
    await assert.rejects(team.assign({ name: "d", prompt: "x" }, false), /budget is spent/);
  });

  it("refuses a new worker when too little budget is left", async () => {
    const { team, supervisor } = setup(1);
    supervisor.costUsd = 0.97;
    await assert.rejects(team.assign({ name: "a", prompt: "x" }, false), /Too little/);
  });

  it("reports a worker's failed turn as an error in its report", async () => {
    const { team, workers } = setup();
    const answer = team.assign({ name: "a", prompt: "x" }, true);
    await Promise.resolve();
    workers[0]?.finish("", 0.1, true);
    const r = (await answer) as Handoff;
    assert.equal(r.isError, true);
    assert.match(r.text, /stopped: error_during_execution/);
  });

  it("lists workers with their status and last report, and closes them all with the supervisor", async () => {
    const { team, workers } = setup();
    await team.assign({ name: "a", prompt: "x" }, false);
    await team.assign({ name: "b", prompt: "y", access: "write" }, false);
    workers[0]?.finish("A", 0.25);
    assert.deepEqual(team.list(), [
      { workerId: "w1", name: "a", access: "read", status: "idle", costUsd: 0.25, lastReport: "A" },
      { workerId: "w2", name: "b", access: "write", status: "working", costUsd: 0 },
    ]);
    await team.close();
    assert.deepEqual(
      workers.map((w) => w.closed),
      [true, true],
    );
  });
});

describe("teamTools (M8-03)", () => {
  /** The server definition as the SDK would get it: each tool's name and handler. */
  const fakeSdk = {
    createSdkMcpServer: (o: unknown) => o,
    tool: (name: string, _d: string, _s: unknown, handler: (a: unknown) => Promise<unknown>) => ({ name, handler }),
  } as unknown as AgentSdkModule;

  it("names the server and its tools, and returns a refusal as the tool's error", async () => {
    const { team } = setup();
    const server = teamTools(fakeSdk, team) as unknown as {
      name: string;
      alwaysLoad: boolean;
      tools: { name: string; handler: (a: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }[];
    };
    assert.equal(server.name, "agentchainer");
    assert.equal(server.alwaysLoad, true);
    assert.deepEqual(
      server.tools.map((t) => t.name),
      ["assign", "handoff", "send_message", "read_inbox", "list_workers", "close_worker"],
    );
    const call = (name: string, args: unknown) => server.tools.find((t) => t.name === name)?.handler(args);
    assert.deepEqual(await call("assign", { name: "a", prompt: "x" }), {
      content: [{ type: "text", text: '{"workerId":"w1"}' }],
    });
    assert.deepEqual(await call("send_message", { worker: "nope", text: "hi" }), {
      content: [{ type: "text", text: "No worker nope; list_workers shows them." }],
      isError: true,
    });
  });
});

describe("Team workers with agent profiles (M8-04)", () => {
  const explainer = {
    name: "explainer",
    description: "Explains",
    scope: "project" as const,
    prompt: "You explain.",
    tools: ["Read"],
  };

  it("starts a worker as a profile, and refuses an unknown one as the tool's error", async () => {
    const specs: WorkerSpec[] = [];
    const team = new Team(
      5,
      {
        emit: () => undefined,
        open: (spec) => {
          specs.push(spec);
          return new FakeMember(`w${specs.length}`);
        },
      },
      (name) => {
        if (name === "explainer") return explainer;
        throw new Error(`There is no agent profile named ${name}.`);
      },
    );
    await team.assign({ name: "a", prompt: "x", profile: "explainer" }, false);
    assert.deepEqual(specs[0]?.profile, explainer);
    await assert.rejects(team.assign({ name: "b", prompt: "x", profile: "ghost" }, false), (err: Error) => {
      assert.ok(err instanceof TeamError);
      assert.match(err.message, /no agent profile named ghost/);
      return true;
    });
    assert.equal(specs.length, 1, "no worker for an unknown profile");
  });

  it("lists the profiles in the supervisor's instructions", () => {
    assert.equal(teamInstructions([]), TEAM_INSTRUCTIONS);
    assert.match(
      teamInstructions([{ name: "explainer", description: "Explains code.\nMore." }]),
      /Agent profiles a worker can run as[\s\S]*- explainer: Explains code\.$/,
    );
  });
});
