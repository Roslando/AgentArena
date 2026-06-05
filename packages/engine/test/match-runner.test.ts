import { afterEach, describe, expect, it, vi } from "vitest";

// Shared spies, hoisted so the vi.mock factories below can see them.
const spies = vi.hoisted(() => ({
  sendCalls: [] as string[], // provider ids asked to produce a move
  toolCalls: [] as string[], // MCP tool names actually executed
}));

// MatchLogger writes to disk; stub it to keep the test pure (entries in memory).
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

// Fake MCP server exposing the chess tool surface. get_board returns a White board;
// make_move would apply by side-to-move — so if it is ever called here, the opponent
// "stole" the turn (the bug). The test asserts it is never called.
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
      if (name === "get_board") {
        const board = { you_are: "white", ascii: "(board)", your_faults: 0 };
        return { content: [{ type: "text", text: JSON.stringify(board) }] };
      }
      return {};
    }
    async disconnect() {}
  },
}));

// Every provider returns a no-tool-call response — simulates output truncated at
// maxTokens (finishReason "length"), the exact condition that corrupted live matches.
vi.mock("../src/providers/factory.js", () => ({
  createProvider: (id: string) => ({
    providerId: id,
    async send() {
      spies.sendCalls.push(id);
      return {
        content: "",
        toolCalls: [],
        tokensInput: 1,
        tokensOutput: 1,
        finishReason: "length",
      };
    },
  }),
}));

import { MatchConfigSchema } from "@agentarena/types";
import { MatchRunner } from "../src/match-runner.js";

const config = MatchConfigSchema.parse({
  matchId: "test-no-move",
  players: [
    { id: "player-1", name: "White", provider: { type: "openai", model: "m" } },
    { id: "player-2", name: "Black", provider: { type: "openai", model: "m" } },
  ],
  mcpServer: { transport: "stdio", command: "x", args: [] },
  stateToolName: "get_board",
  limits: { maxRetriesPerTurn: 3 },
});

afterEach(() => {
  spies.sendCalls.length = 0;
  spies.toolCalls.length = 0;
});

describe("MatchRunner — no-move turns", () => {
  it("retries the same player and forfeits it, never letting the opponent play", async () => {
    const runner = new MatchRunner(config);
    const result = await runner.run();

    // The stalling player (White) forfeits; the opponent wins by forfeit.
    expect(result.reason).toBe("forfeit");
    expect(result.winnerId).toBe("player-2");

    // Only the SAME player was retried, exactly maxRetriesPerTurn times.
    expect(spies.sendCalls).toEqual(["player-1", "player-1", "player-1"]);

    // Critically: make_move was never executed, so the opponent never moved.
    expect(spies.toolCalls).not.toContain("make_move");
  });
});
