import { afterEach, describe, expect, it, vi } from "vitest";

// Shared, hoisted state so the vi.mock factories below can record calls.
const spies = vi.hoisted(() => ({
  callCount: {} as Record<string, number>, // per-provider send count
  submitCount: 0, // how many times the action tool has been called
  userMsgs: [] as string[], // last user message of each send (to inspect re-prompts)
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

// Fake GENERIC (non-chess) MCP: a `get_state` reader and a `submit` action. The first
// submit is rejected (a model fault); the second completes the task with NO winner.
vi.mock("../src/mcp-manager.js", () => ({
  McpManager: class {
    async connect() {}
    get connected() {
      return true;
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
        spies.submitCount++;
        if (spies.submitCount === 1) {
          // Rejected action → counts as an invalid action, re-prompts the same player.
          return {
            content: [
              { type: "text", text: JSON.stringify({ accepted: false, message: "bad arg" }) },
            ],
          };
        }
        // Accepted + task complete, but NO winner declared.
        return {
          content: [{ type: "text", text: JSON.stringify({ accepted: true }) }],
          game_over: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ state: "open" }) }] };
    }
    async disconnect() {}
  },
}));

// Provider: player-1 reads get_state once, then calls `submit` (never `make_move`).
vi.mock("../src/providers/factory.js", () => ({
  createProvider: (id: string) => ({
    providerId: id,
    async send(messages: Array<{ role: string; content: string }>) {
      spies.callCount[id] = (spies.callCount[id] ?? 0) + 1;
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      spies.userMsgs.push(lastUser?.content ?? "");
      const tool = spies.callCount[id] === 1 ? "get_state" : "submit";
      return {
        content: "working",
        toolCalls: [
          { id: "tc1", type: "function" as const, function: { name: tool, arguments: "{}" } },
        ],
        tokensInput: 1,
        tokensOutput: 1,
        finishReason: "tool_calls",
      };
    },
  }),
}));

import { type LogEntry, MatchConfigSchema } from "@agentarena/types";
import { MatchRunner } from "../src/match-runner.js";

const config = MatchConfigSchema.parse({
  matchId: "test-generic",
  players: [
    { id: "player-1", name: "Alpha", provider: { type: "openai", model: "m" } },
    { id: "player-2", name: "Beta", provider: { type: "openai", model: "m" } },
  ],
  mcpServer: { transport: "stdio", command: "x", args: [] },
  stateToolName: "get_state",
});

afterEach(() => {
  spies.submitCount = 0;
  spies.userMsgs.length = 0;
  for (const k of Object.keys(spies.callCount)) delete spies.callCount[k];
});

describe("MatchRunner — generic (non-chess) MCP", () => {
  it("runs a winner-less task and logs generic per-model stats", async () => {
    const entries: LogEntry[] = [];
    const runner = new MatchRunner(config, (e) => entries.push(e));
    const result = await runner.run();

    // Task completed with no winner declared.
    expect(result.reason).toBe("game_over");
    expect(result.winnerId).toBeUndefined();

    // match.summary carries the generic agentic stats, first-class.
    const summary = entries.find((e) => e.type === "match.summary") as
      | { players: Array<{ playerId: string; toolCalls: number; invalidActions: number }> }
      | undefined;
    expect(summary).toBeDefined();
    const p1 = summary?.players.find((p) => p.playerId === "player-1");
    expect(p1?.toolCalls).toBe(3); // get_state + rejected submit + accepted submit
    expect(p1?.invalidActions).toBe(1); // the rejected submit
  });

  it("phrases its re-prompts from the MCP's real tool names, never make_move", async () => {
    const runner = new MatchRunner(config);
    await runner.run();

    const joined = spies.userMsgs.join("\n");
    expect(joined).toContain("submit"); // re-prompts name the actual action tool
    expect(joined).not.toContain("make_move"); // no chess assumption leaks
    expect(joined).toContain("Invalid action"); // generic rejection wording
  });
});
