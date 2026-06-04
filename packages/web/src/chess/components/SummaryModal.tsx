import { Fragment } from "react";
import { costUsd, fmtUsd, materialOf } from "../state/metrics";
import type { MatchState, PlayerView } from "../state/types";
import { BrandMark } from "./BrandMark";
import { RadarChart } from "./RadarChart";

const COLOR_A = "#2563EB"; // blue  — player 1 (white)
const COLOR_B = "#E8833A"; // orange — player 2 (black)  (accessible pair, never red/green)

function fmtSecs(ms: number): string {
  if (ms <= 0) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** Normalize "lower is better" pair → best gets 100, the other proportionally. */
function lowerPair(va: number, vb: number): [number, number] {
  const m = Math.min(va, vb);
  return [va > 0 ? (m / va) * 100 : 100, vb > 0 ? (m / vb) * 100 : 100];
}

/** Normalize "higher is better" pair → best gets 100. */
function higherPair(va: number, vb: number): [number, number] {
  const m = Math.max(va, vb);
  return [m > 0 ? (va / m) * 100 : 40, m > 0 ? (vb / m) * 100 : 40];
}

/** 3 illegal moves = forfeit, so faults map onto a fixed 0–100 reliability scale. */
function reliability(faults: number): number {
  return ((3 - Math.min(Math.max(faults, 0), 3)) / 3) * 100;
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

/**
 * End-of-match report — an editorial, share-ready card (light "paper" theme):
 * a radar of the head-to-head profile (shape) + a companion table (exact numbers).
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

  const movesA = Math.max(a.turns, 1);
  const movesB = Math.max(b.turns, 1);

  const matA = materialOf(state.capturedByBlack); // white's score = black's losses
  const matB = materialOf(state.capturedByWhite);
  const costA = costUsd(a);
  const costB = costUsd(b);
  const hasCost = costA !== null && costB !== null;

  const outcome = (p: PlayerView) =>
    state.winnerId === p.id ? "win" : state.winnerId ? "loss" : "draw";
  const outcomeScore = (o: string) => (o === "win" ? 100 : o === "draw" ? 55 : 22);

  // Radar profiles (fixed axis order: outcome → agentic efficiency → game material).
  const axes = ["Outcome", "Reliability", "Speed", "Concision"];
  const [spdA, spdB] = lowerPair(a.avgLlmLatencyMs, b.avgLlmLatencyMs);
  const [concA, concB] = lowerPair(a.tokensOutput / movesA, b.tokensOutput / movesB);
  const valA = [outcomeScore(outcome(a)), reliability(a.faults), spdA, concA];
  const valB = [outcomeScore(outcome(b)), reliability(b.faults), spdB, concB];
  if (hasCost) {
    const [cA, cB] = lowerPair((costA as number) / movesA, (costB as number) / movesB);
    axes.push("Cost");
    valA.push(cA);
    valB.push(cB);
  }
  axes.push("Material");
  const [mA, mB] = higherPair(matA, matB);
  valA.push(mA);
  valB.push(mB);

  // Verdict sentence.
  const winner = state.winnerId ? state.players.find((p) => p.id === state.winnerId) : null;
  let verdict: string;
  if (!winner) {
    verdict = "Draw — neither side converted a decisive edge.";
  } else {
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
  }

  // Companion table — exact numbers; mark which model wins each row.
  type Row = { label: string; va: string; vb: string; better: -1 | 0 | 1 };
  const cmp = (xa: number, xb: number, lowerWins: boolean): -1 | 0 | 1 => {
    if (xa === xb) return 0;
    const aWins = lowerWins ? xa < xb : xa > xb;
    return aWins ? -1 : 1;
  };
  const outLabel = (p: PlayerView) =>
    outcome(p) === "win" ? "✓ Win" : outcome(p) === "draw" ? "Draw" : "Loss";
  const rows: Row[] = [
    {
      label: "Outcome",
      va: outLabel(a),
      vb: outLabel(b),
      better: outcome(a) === "win" ? -1 : outcome(b) === "win" ? 1 : 0,
    },
    {
      label: "Illegal moves",
      va: `${a.faults}/3`,
      vb: `${b.faults}/3`,
      better: cmp(a.faults, b.faults, true),
    },
    {
      label: "Reflection / move",
      va: fmtSecs(a.avgLlmLatencyMs),
      vb: fmtSecs(b.avgLlmLatencyMs),
      better: cmp(a.avgLlmLatencyMs, b.avgLlmLatencyMs, true),
    },
    {
      label: "Tokens out / move",
      va: String(Math.round(a.tokensOutput / movesA)),
      vb: String(Math.round(b.tokensOutput / movesB)),
      better: cmp(a.tokensOutput / movesA, b.tokensOutput / movesB, true),
    },
    {
      label: "Material won",
      va: `${matA} pts`,
      vb: `${matB} pts`,
      better: cmp(matA, matB, false),
    },
  ];
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
            {winner ? "Result" : "Draw"}
          </div>
          <h2 className="font-report mt-1 text-3xl font-semibold leading-tight text-[#161513]">
            {winner ? (
              <>
                {winner.name} <span className="bg-[#FCE38A] px-1.5">wins</span>
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
