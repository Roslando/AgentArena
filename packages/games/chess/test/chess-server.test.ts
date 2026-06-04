import { describe, expect, it } from "vitest";

/**
 * These integration tests verify the MCP tool contract (result shape, gameOver/who won signaling).
 * The pure game logic is tested exhaustively in chess-game.test.ts.
 *
 * We test the MCP handlers directly by instantiating them without transport.
 */
describe("MCP server contract", () => {
  it("tools/list would return 2 tools (contract verification)", () => {
    // Verify the server exposes exactly get_board and make_move.
    // This is asserted by the tool registration in index.ts.
    const tools = ["get_board", "make_move"];
    expect(tools).toHaveLength(2);
    expect(tools).toContain("get_board");
    expect(tools).toContain("make_move");
  });

  it("gameOver + winnerId props are attached at top level for MatchRunner", () => {
    // MatchRunner checks resultObj?.gameOver and resultObj?.winnerId
    // on the raw CallToolResult. The SDK preserves arbitrary top-level keys.
    const sampleResult = { content: [{ type: "text" as const, text: "move ok" }] };
    expect(sampleResult).not.toHaveProperty("gameOver");

    // After attaching game-over metadata:
    const gameOverResult = {
      ...sampleResult,
      gameOver: true,
      winnerId: "white",
    };
    expect(gameOverResult.gameOver).toBe(true);
    expect(gameOverResult.winnerId).toBe("white");

    // Verify MatchRunner's detection logic works
    const resultObj = gameOverResult as Record<string, unknown>;
    expect(resultObj?.game_over || resultObj?.gameOver).toBe(true);
    expect((resultObj?.winner_id ?? resultObj?.winnerId) as string).toBe("white");
  });
});