/**
 * Pure agentic scoring — the SINGLE source of truth shared by the web radar and the
 * CLI report, so a model's profile and the "recommended model" verdict never disagree.
 * Every axis is on a fixed, absolute 0–100 scale (opponent-independent), so a model's
 * score means the same in any match.
 *
 * No dependencies: callers adapt their own data shape (web PlayerView, engine
 * match.summary) into {@link AgenticRaw}, then read the scores back.
 */

/** Raw per-model inputs, already reduced to the primitives the scoring needs. */
export interface AgenticRaw {
  /** Task outcome for this player. */
  outcome: "win" | "draw" | "loss";
  /** Accepted actions taken (turns). */
  turns: number;
  /** Rejected/invalid actions — the model's own failures (error signal). */
  invalidActions: number;
  /** Tool calls issued (state reads + actions). */
  toolCalls: number;
  /** Average reflection latency per turn (ms). */
  avgLatencyMs: number;
  /** Output tokens per turn. */
  tokensOutPerTurn: number;
  /** USD cost per turn, or null when no price is configured. */
  costPerTurn: number | null;
}

export interface AgenticScores {
  /** Task outcome: win / draw-or-no-winner / loss. */
  success: number;
  /** Share of actions that were valid (not rejected). */
  reliability: number;
  /** Did invalid actions get corrected instead of spiralling into a forfeit? */
  recovery: number;
  /** Adherence to the observe-then-act protocol (~2 tool calls per action). */
  toolUse: number;
  /** Reflection latency per turn against a fixed anchor. */
  speed: number;
  /** Output tokens per turn against a fixed anchor. */
  concision: number;
  /** Cost per turn against a fixed anchor; null when no price is configured. */
  cost: number | null;
}

// Absolute anchors for the "lower is better" axes: `best` → 100, `worst` → 0.
const SPEED_BEST_MS = 3_000;
const SPEED_WORST_MS = 60_000;
const CONCISION_BEST_TOK = 150;
const CONCISION_WORST_TOK = 2_500;
const COST_BEST_USD = 0.005;
const COST_WORST_USD = 0.08;

function lowerAbs(value: number, best: number, worst: number): number {
  if (worst <= best) return 100;
  return Math.max(0, Math.min(100, (1 - (value - best) / (worst - best)) * 100));
}

function outcomeScore(o: "win" | "draw" | "loss"): number {
  return o === "win" ? 100 : o === "draw" ? 55 : 22;
}

/** The seven agentic axes for one model on a fixed 0–100 scale. */
export function agenticScores(r: AgenticRaw): AgenticScores {
  const attempts = r.turns + r.invalidActions;
  const moves = Math.max(r.turns, 1);
  return {
    success: outcomeScore(r.outcome),
    reliability: attempts > 0 ? (r.turns / attempts) * 100 : 100,
    recovery:
      r.invalidActions >= 3 ? 15 : r.invalidActions <= 0 ? 100 : 100 - r.invalidActions * 25,
    toolUse: Math.max(0, 100 - Math.abs(r.toolCalls / moves - 2) * 50),
    speed: lowerAbs(r.avgLatencyMs, SPEED_BEST_MS, SPEED_WORST_MS),
    concision: lowerAbs(r.tokensOutPerTurn, CONCISION_BEST_TOK, CONCISION_WORST_TOK),
    cost: r.costPerTurn !== null ? lowerAbs(r.costPerTurn, COST_BEST_USD, COST_WORST_USD) : null,
  };
}

// Reliability weighs most (a wrong tool call is the core agentic failure); cost next.
const COMPOSITE_WEIGHTS: Record<keyof AgenticScores, number> = {
  success: 1,
  reliability: 1.5,
  recovery: 1,
  toolUse: 1,
  speed: 1,
  concision: 0.75,
  cost: 1.25,
};

/** Single transparent ranking number: a weighted mean of the available axes. */
export function compositeScore(s: AgenticScores): number {
  let total = 0;
  let weight = 0;
  for (const [k, v] of Object.entries(s) as Array<[keyof AgenticScores, number | null]>) {
    if (v === null) continue;
    total += v * COMPOSITE_WEIGHTS[k];
    weight += COMPOSITE_WEIGHTS[k];
  }
  return weight > 0 ? total / weight : 0;
}

const AXIS_LABEL: Record<keyof AgenticScores, string> = {
  success: "task success",
  reliability: "reliability",
  recovery: "error recovery",
  toolUse: "tool efficiency",
  speed: "speed",
  concision: "concision",
  cost: "cost",
};

/** The model's strongest axes — the "recommended because…" rationale. */
export function topAxes(s: AgenticScores, n = 2): string[] {
  return (Object.entries(s) as Array<[keyof AgenticScores, number | null]>)
    .filter((e): e is [keyof AgenticScores, number] => e[1] !== null)
    .sort((x, y) => y[1] - x[1])
    .slice(0, n)
    .map(([k]) => AXIS_LABEL[k]);
}
