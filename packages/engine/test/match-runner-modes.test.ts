import { afterEach, describe, expect, it, vi } from "vitest";

// Shared, hoisted state so the vi.mock factories below can record calls.
const spies = vi.hoisted(() => ({
  connects: 0, // how many MCP instances were connected (1 per shared match, N for independent)
  submits: 0, // total `submit` action calls across all instances
  callCount: {} as Record<string, number>, // per-provider send count
  // Scripted provider behaviour: a list of tool names to return on successive sends,
  // per provider id. `null` ⇒ reply with NO tool call (a non-action / error turn).
  scripts: {} as Record<string, Array<string | null>>,
}));

vi.mock("../src/match-logger.js", () => ({
  MatchLogger: class {
    private readonly onEntry?: (e: unknown) => void;
    constructor(_id: string, _dir: undefined, onEntry?: (e: unknown) => void) {
      this.onEntry = onEntry;
    }
    write(entry: unknown) {
      this.onEntry?.(entry);
    }
  },
}));

// Fake generic MCP: `get_state` reads; `submit` ends the task (winner-less game_over).
// A fresh instance is constructed per independent episode — connects are counted so the
// test can assert true isolation (one MCP process per model).
vi.mock("../src/mcp-manager.js", () => ({
  McpManager: class {
    private _connected = false;
    async connect() {
      this._connected = true;
      spies.connects++;
    }
    get connected() {
      return this._connected;
    }
    get tools() {
      return [
        { name: "get_state", description: "", inputSchema: {} },
        { name: "submit", description: "", inputSchema: {} },
      ];
    }
    async getSystemPrompt() {
      return null;
    }
    async callTool(name: string) {
      if (name === "submit") {
        spies.submits++;
        return {
          content: [{ type: "text", text: JSON.stringify({ accepted: true }) }],
          game_over: true,
          // Task-specific final stats the MCP exposes — the engine must relay verbatim.
          stats: { score: 7, label: "done" },
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ state: "open" }) }] };
    }
    async disconnect() {
      this._connected = false;
    }
  },
}));

// Provider driven by `spies.scripts[id]`: each send pops the next scripted tool. A `null`
// entry yields a response with no tool call (a non-action turn — the error path). When the
// script runs out, it falls back to a `submit` so a match always terminates.
vi.mock("../src/providers/factory.js", () => ({
  createProvider: (id: string) => ({
    providerId: id,
    async send() {
      spies.callCount[id] = (spies.callCount[id] ?? 0) + 1;
      const n = spies.callCount[id];
      const script = spies.scripts[id] ?? ["get_state", "submit"];
      const tool = n <= script.length ? script[n - 1] : "submit";
      const toolCalls =
        tool === null
          ? []
          : [{ id: "tc1", type: "function" as const, function: { name: tool, arguments: "{}" } }];
      return {
        content: tool === null ? "" : "working",
        toolCalls,
        tokensInput: 1,
        tokensOutput: 1,
        finishReason: tool === null ? "length" : "tool_calls",
      };
    },
  }),
}));

import { type LogEntry, MatchConfigSchema } from "@agentarena/types";
import { MatchRunner } from "../src/match-runner.js";

function makeConfig(overrides: Record<string, unknown>) {
  return MatchConfigSchema.parse({
    matchId: "test-modes",
    players: [
      { id: "player-1", name: "Alpha", provider: { type: "openai", model: "m" } },
      { id: "player-2", name: "Beta", provider: { type: "openai", model: "m" } },
    ],
    mcpServer: { transport: "stdio", command: "x", args: [] },
    stateToolName: "get_state",
    ...overrides,
  });
}

afterEach(() => {
  spies.connects = 0;
  spies.submits = 0;
  for (const k of Object.keys(spies.callCount)) delete spies.callCount[k];
  for (const k of Object.keys(spies.scripts)) delete spies.scripts[k];
});

describe("MatchRunner — orchestration modes", () => {
  it("independent: each model runs the whole task alone on its OWN MCP instance", async () => {
    const entries: LogEntry[] = [];
    const result = await new MatchRunner(makeConfig({ orchestrationMode: "independent" }), (e) =>
      entries.push(e),
    ).run();

    // Two isolated episodes connected two separate MCP instances (true isolation).
    expect(spies.connects).toBe(2);
    // Both agents completed the task → no single solver → no head-to-head winner.
    expect(result.reason).toBe("game_over");
    expect(result.winnerId).toBeUndefined();

    // Each model got its own scorecard, having driven the task through its own tools
    // (read the state, then submitted) — proof both episodes actually ran.
    const summary = entries.find((e) => e.type === "match.summary") as
      | {
          players: Array<{
            playerId: string;
            toolCalls: number;
            taskStats?: Record<string, unknown>;
          }>;
        }
      | undefined;
    expect(summary?.players).toHaveLength(2);
    expect(summary?.players.every((p) => p.toolCalls >= 2)).toBe(true);
    // Each agent has its OWN game_over → its own task stats, relayed per-player.
    expect(summary?.players.every((p) => p.taskStats?.score === 7)).toBe(true);
  });

  it("relays the MCP's game_over `stats` verbatim into match.summary (match-level)", async () => {
    const entries: LogEntry[] = [];
    await new MatchRunner(makeConfig({ orchestrationMode: "turn-by-turn" }), (e) =>
      entries.push(e),
    ).run();

    const summary = entries.find((e) => e.type === "match.summary") as
      | { taskStats?: Record<string, unknown> }
      | undefined;
    // A shared task has one game_over → one match-level taskStats, relayed untouched.
    expect(summary?.taskStats).toEqual({ score: 7, label: "done" });
  });

  it("concurrent: agents act in the same round on one shared MCP until game_over", async () => {
    const result = await new MatchRunner(makeConfig({ orchestrationMode: "concurrent" })).run();

    // A single shared instance, and the task ended once an agent submitted.
    expect(spies.connects).toBe(1);
    expect(result.reason).toBe("game_over");
  });

  it("circuit breaker resets on success: a model that errs then recovers is NOT cut", async () => {
    // player-1 stalls twice (no tool call), then reads + acts. With maxConsecutiveErrors 4,
    // the two strikes never trip the breaker and the recovery resets the streak.
    spies.scripts["player-1"] = [null, null, "get_state", "submit"];
    const result = await new MatchRunner(
      makeConfig({ orchestrationMode: "turn-by-turn", limits: { maxConsecutiveErrors: 4 } }),
    ).run();

    expect(result.reason).toBe("game_over"); // completed, never forfeited
    expect(spies.submits).toBeGreaterThanOrEqual(1);
  });

  it("truncation is counted as a budget signal, NOT an invalid action", async () => {
    // The scripted provider returns finishReason "length" on a `null` entry — i.e. the
    // output was cut off at the token budget before a tool call. player-1 is truncated
    // twice, then recovers and completes the task.
    spies.scripts["player-1"] = [null, null, "get_state", "submit"];
    const entries: LogEntry[] = [];
    await new MatchRunner(
      makeConfig({ orchestrationMode: "turn-by-turn", limits: { maxConsecutiveErrors: 4 } }),
      (e) => entries.push(e),
    ).run();

    const summary = entries.find((e) => e.type === "match.summary") as
      | { players: Array<{ playerId: string; truncations?: number; invalidActions: number }> }
      | undefined;
    const p1 = summary?.players.find((p) => p.playerId === "player-1");
    expect(p1?.truncations).toBe(2); // both cut-offs recorded as a budget signal
    expect(p1?.invalidActions).toBe(0); // truncation never inflates the error rate
  });
});
