import {
  type AgenticScores,
  compositeScore,
  agenticScores as scoreRaw,
  topAxes,
} from "@agentarena/types";
import type { MatchState, PlayerView } from "./types";

// Re-export the shared scoring primitives so components import metrics from one place.
export { compositeScore, topAxes };
export type { AgenticScores };

/** Accumulated USD cost from tokens × configured per-million prices, or null if no price set. */
export function costUsd(p: PlayerView): number | null {
  if (p.priceInputPerM === undefined && p.priceOutputPerM === undefined) return null;
  return (
    (p.tokensInput / 1e6) * (p.priceInputPerM ?? 0) +
    (p.tokensOutput / 1e6) * (p.priceOutputPerM ?? 0)
  );
}

export function fmtUsd(v: number): string {
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

/**
 * Output-token generation throughput (tokens per second), or 0 before any timing.
 *
 * Computed as an aggregate (total output tokens ÷ total LLM seconds) rather than
 * per-call, so amortised TTFT does not skew it. This is the *generation speed*
 * dimension — distinct from how MANY tokens a model spends (over-thinking) and from
 * total latency. Note: completion tokens include hidden reasoning, so this is the
 * effective throughput a user actually waits through.
 */
export function throughputTokPerSec(p: PlayerView): number {
  const secs = p.totalLlmLatencyMs / 1000;
  return secs > 0 ? p.tokensOutput / secs : 0;
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const PIECE_VALUE: Record<string, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9 };

/** Sum the material value of a list of captured pieces. */
export function materialOf(pieces: string[]): number {
  return pieces.reduce((sum, p) => sum + (PIECE_VALUE[p] ?? 0), 0);
}

function outcome(p: PlayerView, state: MatchState): "win" | "draw" | "loss" {
  return state.winnerId === p.id ? "win" : state.winnerId ? "loss" : "draw";
}

/** Adapt a UI PlayerView into the shared agentic scoring. */
export function agenticScores(p: PlayerView, state: MatchState): AgenticScores {
  const moves = Math.max(p.turns, 1);
  const cost = costUsd(p);
  return scoreRaw({
    outcome: outcome(p, state),
    turns: p.turns,
    invalidActions: p.faults,
    toolCalls: p.toolCalls,
    avgLatencyMs: p.avgLlmLatencyMs,
    tokensOutPerTurn: p.tokensOutput / moves,
    costPerTurn: cost !== null ? cost / moves : null,
  });
}

/** Rank players by composite score; the top one is the recommended model for the task. */
export function recommendedPlayer(
  players: PlayerView[],
  state: MatchState,
): { player: PlayerView; scores: AgenticScores; composite: number } | null {
  const ranked = players
    .map((p) => {
      const scores = agenticScores(p, state);
      return { player: p, scores, composite: compositeScore(scores) };
    })
    .sort((x, y) => y.composite - x.composite);
  return ranked[0] ?? null;
}
