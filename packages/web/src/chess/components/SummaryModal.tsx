import { Fragment } from "react";
import {
  agenticScores,
  costUsd,
  fmtUsd,
  materialOf,
  recommendedPlayer,
  throughputTokPerSec,
  topAxes,
} from "../state/metrics";
import type { MatchState, PlayerView } from "../state/types";
import { BrandMark } from "./BrandMark";
import { RadarChart } from "./RadarChart";

const COLOR_A = "#2563EB"; // blue  — player 1 (white)
const COLOR_B = "#E8833A"; // orange — player 2 (black)  (accessible pair, never red/green)

function fmtSecs(ms: number): string {
  if (ms <= 0) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function reasonText(reason: string | null): string {
  switch (reason) {
    case "checkmate":
      return " by checkmate";
    case "forfeit":
      return " by forfeit";
    case "timeout":
      return " on time";
    default:
      return "";
  }
}

/** Reasons the engine emits when a match ends with NO winner for a non-game cause: an
 * aborted/incomplete match, not a competitive draw. A genuine draw ends as "game_over". */
const ABORTED_REASONS = new Set(["mcp_crash", "error", "unknown", "timeout"]);

function abortedVerdict(reason: string | null): string {
  switch (reason) {
    case "mcp_crash":
      return "Match aborted — the task server (MCP) crashed mid-match. No result.";
    case "timeout":
      return "Match stopped on the clock before a decisive result. No winner.";
    case "error":
      return "Match aborted after an internal error. No result.";
    default:
      return "Match ended without a result.";
  }
}

/**
 * End-of-match report — an editorial, share-ready card (light "paper" theme):
 * a radar of the head-to-head profile (shape) + a companion table (exact numbers).
 *
 * Task-agnostic: when the MCP declares a winner (e.g. chess checkmate) we headline it;
 * otherwise we recommend the best-fit model by a transparent composite score. The
 * chess-only Material row and "illegal moves /3" framing are shown only for a move game.
 */
export function SummaryModal({ state, onClose }: { state: MatchState; onClose: () => void }) {
  // Wait for the terminal `match.end` — it sets winnerId + endReason and lands AFTER the
  // final `match.summary`. `game.over` flips status to "over" two entries earlier, so
  // rendering then would make the radar animate toward values that are still being
  // finalized (the "shape morphing" before it settles). endReason is set only by match.end.
  if (state.status !== "over" || state.endReason === null) return null;
  const a = state.players[0];
  const b = state.players[1];
  if (!a || !b) return null;

  // A move game (chess) populates the SAN timeline; a generic task does not. This drives
  // the chess-only framing (Material row, "illegal moves /3", a draw vs a recommendation).
  const isChess = state.moves.length > 0;

  const movesA = Math.max(a.turns, 1);
  const movesB = Math.max(b.turns, 1);

  const matA = materialOf(state.capturedByWhite); // white's material = pieces White captured
  const matB = materialOf(state.capturedByBlack); // black's material = pieces Black captured
  const costA = costUsd(a);
  const costB = costUsd(b);
  const hasCost = costA !== null && costB !== null;

  const outcome = (p: PlayerView) =>
    state.winnerId === p.id ? "win" : state.winnerId ? "loss" : "draw";

  // Radar = the agentic profile, on a fixed absolute 0–100 scale (opponent-independent),
  // shared with the "recommended model" composite below so both read from one source.
  const scoresA = agenticScores(a, state);
  const scoresB = agenticScores(b, state);
  const axes = ["Success", "Reliability", "Recovery", "Tool Use", "Speed", "Concision"];
  const valA = [
    scoresA.success,
    scoresA.reliability,
    scoresA.recovery,
    scoresA.toolUse,
    scoresA.speed,
    scoresA.concision,
  ];
  const valB = [
    scoresB.success,
    scoresB.reliability,
    scoresB.recovery,
    scoresB.toolUse,
    scoresB.speed,
    scoresB.concision,
  ];
  if (hasCost) {
    axes.push("Cost");
    valA.push(scoresA.cost as number);
    valB.push(scoresB.cost as number);
  }

  // Verdict sentence.
  const winner = state.winnerId ? state.players.find((p) => p.id === state.winnerId) : null;
  // No winner is a genuine DRAW only when a move game ended that way; the engine also ends
  // with no winner on infrastructure failure (mcp_crash / error / unknown) or a timeout —
  // those are aborted matches, NOT draws.
  const aborted = !winner && state.endReason !== null && ABORTED_REASONS.has(state.endReason);
  // A non-aborted, no-winner finish on a NON-move task: recommend the best-fit model
  // instead of forcing a "draw" (which only makes sense for a move game like chess).
  const genericRec = !winner && !aborted && !isChess;
  const rec = recommendedPlayer([a, b], state);

  let verdict: string;
  if (aborted) {
    verdict = abortedVerdict(state.endReason);
  } else if (winner) {
    const loser = state.players.find((p) => p.id !== winner.id);
    const wCost = costUsd(winner);
    const lCost = loser ? costUsd(loser) : null;
    let clause = "";
    if (wCost !== null && lCost !== null && lCost > 0 && loser) {
      const ratio = wCost / lCost;
      if (ratio >= 1.3) clause = ` But it cost ${ratio.toFixed(1)}× more than ${loser.name}.`;
      else if (ratio <= 0.77) clause = ` And for less than ${loser.name}.`;
    }
    verdict = `${winner.name} wins${reasonText(state.endReason)}.${clause}`;
  } else if (genericRec && rec) {
    verdict = `Recommended for this task: ${rec.player.name} — strongest on ${topAxes(rec.scores).join(" and ")}.`;
  } else {
    verdict = "Draw — neither side converted a decisive edge.";
  }

  // Companion table — exact numbers; mark which model wins each row. Ordered like a
  // pro scorecard: outcome first, then agentic quality, then efficiency, then the
  // game-specific detail (material) last.
  type Row = { label: string; va: string; vb: string; better: -1 | 0 | 1 };
  const cmp = (xa: number, xb: number, lowerWins: boolean): -1 | 0 | 1 => {
    if (xa === xb) return 0;
    const aWins = lowerWins ? xa < xb : xa > xb;
    return aWins ? -1 : 1;
  };
  const outLabel = (p: PlayerView) =>
    aborted || genericRec
      ? "—"
      : outcome(p) === "win"
        ? "✓ Win"
        : outcome(p) === "draw"
          ? "Draw"
          : "Loss";
  const callsPerMoveA = a.toolCalls / movesA;
  const callsPerMoveB = b.toolCalls / movesB;
  const tpsA = throughputTokPerSec(a);
  const tpsB = throughputTokPerSec(b);
  const rows: Row[] = [
    {
      label: "Result",
      va: outLabel(a),
      vb: outLabel(b),
      better: outcome(a) === "win" ? -1 : outcome(b) === "win" ? 1 : 0,
    },
    // — Agentic quality —
    {
      // Chess surfaces a model's own failures as illegal moves (capped at 3); a generic
      // task calls them invalid actions. Same underlying counter.
      label: isChess ? "Illegal moves" : "Invalid actions",
      va: isChess ? `${a.faults}/3` : `${a.faults}`,
      vb: isChess ? `${b.faults}/3` : `${b.faults}`,
      better: cmp(a.faults, b.faults, true),
    },
    {
      label: "Tool calls (total)",
      va: `${a.toolCalls} (${callsPerMoveA.toFixed(1)}/mv)`,
      vb: `${b.toolCalls} (${callsPerMoveB.toFixed(1)}/mv)`,
      // Closest to the ideal 2 calls/move (observe + act) wins; fewer = acted blind.
      better: cmp(Math.abs(callsPerMoveA - 2), Math.abs(callsPerMoveB - 2), true),
    },
    // — Efficiency —
    {
      label: "Reflection / move",
      va: fmtSecs(a.avgLlmLatencyMs),
      vb: fmtSecs(b.avgLlmLatencyMs),
      better: cmp(a.avgLlmLatencyMs, b.avgLlmLatencyMs, true),
    },
    {
      label: "Throughput",
      va: `${Math.round(tpsA)} tok/s`,
      vb: `${Math.round(tpsB)} tok/s`,
      better: cmp(tpsA, tpsB, false),
    },
    {
      label: "Tokens out / move",
      va: String(Math.round(a.tokensOutput / movesA)),
      vb: String(Math.round(b.tokensOutput / movesB)),
      better: cmp(a.tokensOutput / movesA, b.tokensOutput / movesB, true),
    },
  ];
  // Truncation = output cut off at the token budget before acting (a model overthinking
  // into its cap). A budget signal, not a fault — shown only when it actually happened so
  // the operator knows to raise maxTokens / lower the reasoning effort for that model.
  if (a.truncations > 0 || b.truncations > 0) {
    rows.push({
      label: "Truncated (raise maxTokens)",
      va: String(a.truncations),
      vb: String(b.truncations),
      better: cmp(a.truncations, b.truncations, true),
    });
  }
  if (hasCost) {
    rows.push(
      {
        label: "Total cost",
        va: fmtUsd(costA as number),
        vb: fmtUsd(costB as number),
        better: cmp(costA as number, costB as number, true),
      },
      {
        label: "Cost / move",
        va: fmtUsd((costA as number) / movesA),
        vb: fmtUsd((costB as number) / movesB),
        better: cmp((costA as number) / movesA, (costB as number) / movesB, true),
      },
    );
  }
  // Game-specific detail, last (not an agentic signal) — only for a move game.
  if (isChess) {
    rows.push({
      label: "Material (chess)",
      va: `${matA} pts`,
      vb: `${matB} pts`,
      better: cmp(matA, matB, false),
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-[#F7F6F2] p-7 text-[#1d1c1a] shadow-2xl">
        {/* Brand row */}
        <div className="flex items-center justify-between border-b border-[#E4E1D8] pb-3">
          <span className="flex items-center gap-2 font-report text-lg font-semibold tracking-tight text-[#161513]">
            <BrandMark size={22} />
            AgentArena
          </span>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#A6A29A]">
            Match Report
          </span>
        </div>

        {/* Headline */}
        <div className="mt-5">
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#A6A29A]">
            {winner ? "Result" : aborted ? "Aborted" : genericRec ? "Recommendation" : "Draw"}
          </div>
          <h2 className="font-report mt-1 text-3xl font-semibold leading-tight text-[#161513]">
            {winner ? (
              <>
                {winner.name} <span className="bg-[#FCE38A] px-1.5">wins</span>
              </>
            ) : aborted ? (
              "No result"
            ) : genericRec && rec ? (
              <>
                {rec.player.name} <span className="bg-[#FCE38A] px-1.5">recommended</span>
              </>
            ) : (
              "Draw"
            )}
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-[#5b5852]">{verdict}</p>
        </div>

        {/* Radar + companion table */}
        <div className="mt-6 flex flex-col items-center gap-6 lg:flex-row lg:items-start lg:gap-8">
          <div className="flex flex-col items-center">
            <RadarChart
              axes={axes}
              series={[
                { name: a.name, color: COLOR_A, values: valA },
                { name: b.name, color: COLOR_B, values: valB },
              ]}
              size={270}
            />
            <div className="mt-2 flex items-center gap-5">
              <Legend color={COLOR_A} name={a.name} />
              <Legend color={COLOR_B} name={b.name} />
            </div>
          </div>

          <div className="w-full flex-1">
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 text-sm">
              <div className="whitespace-nowrap pb-1 font-mono text-[10px] uppercase tracking-wider text-[#A6A29A]">
                Dimension
              </div>
              <div className="whitespace-nowrap pb-1 text-right font-mono text-[10px] uppercase tracking-wider text-[#A6A29A]">
                {a.name}
              </div>
              <div className="whitespace-nowrap pb-1 text-right font-mono text-[10px] uppercase tracking-wider text-[#A6A29A]">
                {b.name}
              </div>
              {rows.map((r, i) => {
                const delay = `${i * 60}ms`;
                return (
                  <Fragment key={r.label}>
                    <div
                      className="report-row-in whitespace-nowrap border-t border-[#ECE9E0] py-2 text-[#5b5852]"
                      style={{ animationDelay: delay }}
                    >
                      {r.label}
                    </div>
                    <div
                      className="report-row-in border-t border-[#ECE9E0] py-2 text-right tabular-nums"
                      style={{
                        animationDelay: delay,
                        ...(r.better === -1 ? { color: COLOR_A, fontWeight: 700 } : {}),
                      }}
                    >
                      {r.va}
                    </div>
                    <div
                      className="report-row-in border-t border-[#ECE9E0] py-2 text-right tabular-nums"
                      style={{
                        animationDelay: delay,
                        ...(r.better === 1 ? { color: COLOR_B, fontWeight: 700 } : {}),
                      }}
                    >
                      {r.vb}
                    </div>
                  </Fragment>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 flex items-center justify-between border-t border-[#E4E1D8] pt-3">
          <span className="font-mono text-[10px] uppercase tracking-wider text-[#A6A29A]">
            Source: AgentArena match log · {state.matchId ?? "—"} · 1 match (not a ranking)
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-[#161513] px-5 py-2 text-sm font-semibold text-[#F7F6F2] hover:bg-[#2b2926]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Legend({ color, name }: { color: string; name: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium text-[#3a3833]">
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      {name}
    </span>
  );
}
