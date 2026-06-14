import { afterEach, describe, expect, it, vi } from "vitest";

// Records, per player id, the turn message each send received — so we can inspect what
// working memory the harness shows back across turns.
const spies = vi.hoisted(() => ({
  acts: 0, // total accepted actions across the match
  callCount: {} as Record<string, number>, // per-provider send count
  userMsgsById: {} as Record<string, string[]>, // per-player, the turn message of each send
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

// MCP: `get_state` reads; `act` is always accepted and ends the task once each player has
// acted twice (4 total) — so player-1 gets a SECOND turn whose message we can inspect.
vi.mock("../src/mcp-manager.js", () => ({
  McpManager: class {
    async connect() {}
    get connected() {
      return true;
    }
    get tools() {
      return [
        { name: "get_state", description: "", inputSchema: {} },
        { name: "act", description: "", inputSchema: {} },
      ];
    }
    async getSystemPrompt() {
      return null;
    }
    async callTool(name: string) {
      if (name === "act") {
        spies.acts++;
        return {
          content: [{ type: "text", text: JSON.stringify({ accepted: true }) }],
          game_over: spies.acts >= 4,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ state: "open" }) }] };
    }
    async disconnect() {}
  },
}));

// Provider: acts directly each turn, with a DISTINCT content per call (its "memory write").
vi.mock("../src/providers/factory.js", () => ({
  createProvider: (id: string) => ({
    providerId: id,
    async send(messages: Array<{ role: string; content: string }>) {
      spies.callCount[id] = (spies.callCount[id] ?? 0) + 1;
      const n = spies.callCount[id];
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (!spies.userMsgsById[id]) spies.userMsgsById[id] = [];
      spies.userMsgsById[id].push(lastUser?.content ?? "");
      return {
        content: `mem-${id}-${n}`,
        toolCalls: [
          { id: "tc1", type: "function" as const, function: { name: "act", arguments: "{}" } },
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
  matchId: "test-memory",
  players: [
    { id: "player-1", name: "Alpha", provider: { type: "openai", model: "m" } },
    { id: "player-2", name: "Beta", provider: { type: "openai", model: "m" } },
  ],
  mcpServer: { transport: "stdio", command: "x", args: [] },
  stateToolName: "get_state",
  orchestrationMode: "turn-by-turn",
});

afterEach(() => {
  spies.acts = 0;
  for (const k of Object.keys(spies.callCount)) delete spies.callCount[k];
  for (const k of Object.keys(spies.userMsgsById)) delete spies.userMsgsById[k];
});

describe("MatchRunner — self-curated working memory", () => {
  it("shows the agent its OWN last message back as a single rewritable memory block", async () => {
    await new MatchRunner(config).run();

    const p1 = spies.userMsgsById["player-1"] ?? [];
    expect(p1.length).toBeGreaterThanOrEqual(2);

    // Turn 1: the agent has nothing to carry yet.
    expect(p1[0]).toContain("no working memory yet");
    expect(p1[0]).not.toContain("mem-player-1");

    // Turn 2: its turn-1 message is shown back as the memory to REWRITE — exactly once
    // (a single block, not an accumulating FIFO), and it's the agent's OWN words.
    expect(p1[1]).toContain("Your working memory (rewrite it");
    expect(p1[1]).toContain("mem-player-1-1");
    expect(p1[1]?.match(/mem-player-1-1/g)).toHaveLength(1);

    // It never sees the opponent's memory.
    expect(p1[1]).not.toContain("mem-player-2");
  });
});
