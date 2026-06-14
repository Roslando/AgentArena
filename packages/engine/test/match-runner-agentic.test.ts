import { afterEach, describe, expect, it, vi } from "vitest";

// Shared, hoisted state so the vi.mock factories below can record calls.
const spies = vi.hoisted(() => ({
  sendCalls: [] as string[], // provider ids asked to act
  toolCalls: [] as string[], // MCP tool names executed
  callCount: {} as Record<string, number>, // per-provider send count
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

// Fake MCP: get_board returns a board; make_move ends the game (player-1 wins).
vi.mock("../src/mcp-manager.js", () => ({
  McpManager: class {
    async connect() {}
    get tools() {
      return [
        { name: "get_board", description: "", inputSchema: {} },
        { name: "make_move", description: "", inputSchema: {} },
      ];
    }
    async getSystemPrompt() {
      return null;
    }
    async callTool(name: string) {
      spies.toolCalls.push(name);
      if (name === "make_move") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ accepted: true, san: "Qf7#", game_over: true }),
            },
          ],
          gameOver: true,
          winnerId: "player-1",
        };
      }
      const board = { you_are: "white", ascii: "(board)", your_faults: 0 };
      return { content: [{ type: "text", text: JSON.stringify(board) }] };
    }
    async disconnect() {}
  },
}));

// Provider: player-1 inspects the board (get_board) BEFORE moving (make_move).
// A correct engine must let it move on the SAME turn — never hand the turn over.
vi.mock("../src/providers/factory.js", () => ({
  createProvider: (id: string) => ({
    providerId: id,
    async send() {
      spies.sendCalls.push(id);
      spies.callCount[id] = (spies.callCount[id] ?? 0) + 1;
      // First a read-only get_board, then the actual move.
      const tool = spies.callCount[id] === 1 ? "get_board" : "make_move";
      return {
        content: "thinking",
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

import { MatchConfigSchema } from "@agentarena/types";
import { MatchRunner } from "../src/match-runner.js";

const config = MatchConfigSchema.parse({
  matchId: "test-agentic-turn",
  players: [
    { id: "player-1", name: "White", provider: { type: "openai", model: "m" } },
    { id: "player-2", name: "Black", provider: { type: "openai", model: "m" } },
  ],
  mcpServer: { transport: "stdio", command: "x", args: [] },
  stateToolName: "get_board",
});

afterEach(() => {
  spies.sendCalls.length = 0;
  spies.toolCalls.length = 0;
  for (const k of Object.keys(spies.callCount)) delete spies.callCount[k];
});

describe("MatchRunner — read-then-move turns", () => {
  it("lets a player call get_board before moving without losing its turn", async () => {
    const runner = new MatchRunner(config);
    const result = await runner.run();

    // player-1 was re-prompted after its get_board and moved on the SAME turn:
    // the opponent (player-2) was NEVER asked to act. Regression guard for the
    // bug where any successful tool call (incl. a read-only get_board) ended the
    // turn and handed the move — applied by side-to-move — to the rival.
    expect(spies.sendCalls).toEqual(["player-1", "player-1"]);
    expect(spies.toolCalls).toContain("make_move");
    expect(result.reason).toBe("game_over");
    expect(result.winnerId).toBe("player-1");
  });
});
