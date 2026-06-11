import { afterEach, describe, expect, it, vi } from "vitest";

// Shared, hoisted state so the vi.mock factories below can record calls.
const spies = vi.hoisted(() => ({
  sendCalls: [] as string[],
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

// MCP server whose transport is dead: every callTool throws and `connected` is
// false — the exact signature of the game-server process crashing mid-match.
vi.mock("../src/mcp-manager.js", () => ({
  McpManager: class {
    async connect() {}
    get connected() {
      return false;
    }
    get tools() {
      return [
        { name: "get_board", description: "", inputSchema: {} },
        { name: "make_move", description: "", inputSchema: {} },
      ];
    }
    async getSystemPrompt() {
      return null;
    }
    async callTool(): Promise<unknown> {
      throw new Error("MCP transport closed");
    }
    async disconnect() {}
  },
}));

// Provider that calls the read tool first — so the runner reaches callTool and
// hits the crash, rather than failing earlier on a no-move response.
vi.mock("../src/providers/factory.js", () => ({
  createProvider: (id: string) => ({
    providerId: id,
    async send() {
      spies.sendCalls.push(id);
      return {
        content: "let me look",
        toolCalls: [
          {
            id: "tc1",
            type: "function" as const,
            function: { name: "get_board", arguments: "{}" },
          },
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
  matchId: "test-mcp-crash",
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
});

describe("MatchRunner — MCP server crash", () => {
  it("ends with no winner instead of forfeiting a player to its opponent", async () => {
    const runner = new MatchRunner(config);
    const result = await runner.run();

    // Infrastructure failure must not crown a winner, and must not burn through
    // the faulting player's retries to hand the match to the rival.
    expect(result.reason).toBe("mcp_crash");
    expect(result.winnerId).toBeUndefined();
    expect(spies.sendCalls).toEqual(["player-1"]);
  });
});
