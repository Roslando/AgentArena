import { describe, expect, it } from "vitest";
import { agenticScores, compositeScore, recommendedPlayer } from "../src/chess/state/metrics";
import { type MatchState, type PlayerView, initialMatchState } from "../src/chess/state/types";

function player(over: Partial<PlayerView>): PlayerView {
  return {
    id: "p",
    name: "P",
    providerType: "openai",
    model: "m",
    color: "white",
    thinking: false,
    messages: [],
    turns: 10,
    tokensInput: 1000,
    tokensOutput: 2000,
    totalLlmLatencyMs: 100_000,
    avgLlmLatencyMs: 10_000,
    faults: 0,
    toolCalls: 20,
    ...over,
  };
}

function finishedState(players: PlayerView[], winnerId: string | null = null): MatchState {
  return { ...initialMatchState(), status: "over", endReason: "game_over", winnerId, players };
}

describe("agentic metrics", () => {
  it("scores reliability from invalid actions (faults), opponent-independent", () => {
    const clean = agenticScores(player({ id: "a", faults: 0 }), finishedState([]));
    const sloppy = agenticScores(player({ id: "b", faults: 3 }), finishedState([]));
    expect(clean.reliability).toBe(100);
    expect(clean.reliability).toBeGreaterThan(sloppy.reliability);
  });

  it("leaves the cost axis null when no price is configured", () => {
    expect(agenticScores(player({}), finishedState([])).cost).toBeNull();
  });

  it("recommends the better-fit model by composite when no winner is declared", () => {
    // Same speed/concision; Alpha is flawless and cheap, Beta errs and costs more.
    const a = player({
      id: "a",
      name: "Alpha",
      faults: 0,
      toolCalls: 20,
      priceInputPerM: 1,
      priceOutputPerM: 2,
    });
    const b = player({
      id: "b",
      name: "Beta",
      faults: 3,
      toolCalls: 40,
      priceInputPerM: 5,
      priceOutputPerM: 10,
    });
    const state = finishedState([a, b], null);
    const rec = recommendedPlayer([a, b], state);
    expect(rec?.player.id).toBe("a");
    expect(compositeScore(agenticScores(a, state))).toBeGreaterThan(
      compositeScore(agenticScores(b, state)),
    );
  });
});
