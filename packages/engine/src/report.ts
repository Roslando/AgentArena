import {
  type AgenticScores,
  type LogEntry,
  type MatchEndEntry,
  type MatchStartEntry,
  type MatchSummaryEntry,
  agenticScores,
  compositeScore,
  topAxes,
} from "@agentarena/types";

/** Per-model agentic statistics derived from a match log — the decision artifact. */
export interface PlayerReport {
  id: string;
  name: string;
  model: string;
  outcome: "win" | "draw" | "loss";
  turns: number;
  toolCalls: number;
  invalidActions: number;
  /** invalidActions / (turns + invalidActions), 0..1. */
  errorRate: number;
  /** Responses cut off at the token budget before acting — a budget signal, not an error. */
  truncations: number;
  avgLatencyMs: number;
  tokPerSec: number;
  tokensOutPerTurn: number;
  totalTokens: number;
  /** Cumulative reflection time (sum of LLM latencies). */
  totalReflectionMs: number;
  costUsd: number | null;
  scores: AgenticScores;
  /** Weighted composite of the agentic axes, 0..100. */
  composite: number;
  /** Opaque task stats the MCP attached to this player's game_over (independent mode). */
  taskStats?: Record<string, unknown>;
}

export interface MatchReport {
  matchId: string;
  reason: string;
  winnerId: string | null;
  matchDurationMs: number;
  players: PlayerReport[];
  /** The best-fit model for the task (highest composite). */
  recommendedId: string | null;
  recommendedWhy: string[];
  /** Opaque task stats the MCP exposed at game_over — relayed, never interpreted. */
  taskStats?: Record<string, unknown>;
}

/**
 * Build the per-model agentic report from a match log. Task-agnostic: it reads only the
 * generic stats in `match.summary` (no chess assumptions). A log file may hold several
 * matches (append-only) — this reports on the LAST one.
 */
export function buildReport(entries: LogEntry[]): MatchReport | null {
  let startIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "match.start") {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return null;
  const start = entries[startIdx] as MatchStartEntry;
  const tail = entries.slice(startIdx);
  const summary = tail.find((e) => e.type === "match.summary") as MatchSummaryEntry | undefined;
  if (!summary) return null;
  const end = tail.find((e) => e.type === "match.end") as MatchEndEntry | undefined;
  const winnerId = end?.winnerId ?? null;

  const roster = new Map(start.players.map((p) => [p.id, p]));
  const players: PlayerReport[] = summary.players.map((s) => {
    const r = roster.get(s.playerId);
    const moves = Math.max(s.turns, 1);
    // Logs predating the stats fields may omit these counters — default to 0 so the
    // report still renders cleanly on an older log.
    const toolCalls = (s.toolCalls as number | undefined) ?? 0;
    const invalidActions = (s.invalidActions as number | undefined) ?? 0;
    const truncations = (s.truncations as number | undefined) ?? 0;
    const hasPrice = r?.priceInputPerM !== undefined || r?.priceOutputPerM !== undefined;
    const costUsd = hasPrice
      ? (s.totalTokensInput / 1e6) * (r?.priceInputPerM ?? 0) +
        (s.totalTokensOutput / 1e6) * (r?.priceOutputPerM ?? 0)
      : null;
    const outcome: "win" | "draw" | "loss" =
      winnerId === s.playerId ? "win" : winnerId ? "loss" : "draw";
    const tokensOutPerTurn = s.totalTokensOutput / moves;
    const scores = agenticScores({
      outcome,
      turns: s.turns,
      invalidActions,
      toolCalls,
      avgLatencyMs: s.avgLlmLatencyMs,
      tokensOutPerTurn,
      costPerTurn: costUsd !== null ? costUsd / moves : null,
    });
    return {
      id: s.playerId,
      name: r?.name ?? s.playerId,
      model: r?.model ?? "—",
      outcome,
      turns: s.turns,
      toolCalls,
      invalidActions,
      errorRate: s.turns + invalidActions > 0 ? invalidActions / (s.turns + invalidActions) : 0,
      truncations,
      ...(s.taskStats ? { taskStats: s.taskStats } : {}),
      avgLatencyMs: s.avgLlmLatencyMs,
      tokPerSec: s.totalLlmLatencyMs > 0 ? s.totalTokensOutput / (s.totalLlmLatencyMs / 1000) : 0,
      tokensOutPerTurn,
      totalTokens: s.totalTokens,
      totalReflectionMs: s.totalLlmLatencyMs,
      costUsd,
      scores,
      composite: compositeScore(scores),
    };
  });

  const top = [...players].sort((a, b) => b.composite - a.composite)[0] ?? null;

  return {
    matchId: start.matchId,
    reason: end?.reason ?? "unknown",
    winnerId,
    matchDurationMs: summary.matchDurationMs,
    players,
    recommendedId: top?.id ?? null,
    recommendedWhy: top ? topAxes(top.scores) : [],
    ...(summary.taskStats ? { taskStats: summary.taskStats } : {}),
  };
}

function fmtMs(ms: number): string {
  if (ms <= 0) return "—";
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function fmtUsd(v: number | null): string {
  if (v === null) return "—";
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

/** Render the report as a clean, share-ready terminal table. */
export function formatReport(report: MatchReport): string {
  const cols = report.players;
  const W = 16;
  const label = (s: string) => s.padEnd(22);
  const cell = (s: string) => s.padStart(W);
  const row = (name: string, get: (p: PlayerReport) => string) =>
    label(name) + cols.map((p) => cell(get(p))).join("");

  const lines: string[] = [`AgentArena — ${report.matchId}`];
  const winner = report.winnerId
    ? (cols.find((p) => p.id === report.winnerId)?.name ?? report.winnerId)
    : null;
  lines.push(
    winner
      ? `Result: ${winner} wins (${report.reason}) · ${fmtMs(report.matchDurationMs)}`
      : `Result: no winner (${report.reason}) · ${fmtMs(report.matchDurationMs)}`,
  );
  const rec = report.players.find((p) => p.id === report.recommendedId);
  if (rec) {
    lines.push(
      `Recommended for this task: ${rec.name} — strongest on ${report.recommendedWhy.join(", ")} (composite ${rec.composite.toFixed(0)}/100)`,
    );
  }
  lines.push("");
  lines.push(label("Model") + cols.map((p) => cell(p.name)).join(""));
  lines.push("-".repeat(22 + cols.length * W));
  lines.push(row("Outcome", (p) => p.outcome));
  lines.push(row("Turns", (p) => String(p.turns)));
  lines.push(row("Tool calls", (p) => String(p.toolCalls)));
  lines.push(
    row("Invalid actions", (p) => `${p.invalidActions} (${(p.errorRate * 100).toFixed(0)}%)`),
  );
  // Only surface truncation when it actually happened — it points at a too-low maxTokens,
  // not at the model, so it stays out of the way on a clean run.
  if (cols.some((p) => p.truncations > 0)) {
    lines.push(row("Truncated (raise maxTokens)", (p) => String(p.truncations)));
  }
  lines.push(row("Reflection / turn", (p) => fmtMs(p.avgLatencyMs)));
  lines.push(row("Throughput", (p) => `${p.tokPerSec.toFixed(0)} tok/s`));
  lines.push(row("Tokens / turn", (p) => p.tokensOutPerTurn.toFixed(0)));
  lines.push(row("Total tokens", (p) => String(p.totalTokens)));
  lines.push(row("Total reflection", (p) => fmtMs(p.totalReflectionMs)));
  lines.push(row("Cost", (p) => fmtUsd(p.costUsd)));
  lines.push(row("Composite /100", (p) => p.composite.toFixed(0)));

  // Task-specific stats the MCP exposed (relayed verbatim, never interpreted): match-level
  // for shared modes, per-player for independent runs. Shown only when the task provided any.
  const perPlayerStats = cols.filter((p) => p.taskStats);
  if (report.taskStats || perPlayerStats.length > 0) {
    lines.push("");
    lines.push("Task stats (from the MCP):");
    if (report.taskStats) {
      for (const [k, v] of Object.entries(report.taskStats))
        lines.push(`  ${k}: ${fmtStatValue(v)}`);
    }
    for (const p of perPlayerStats) {
      lines.push(`  ${p.name}: ${fmtStatValue(p.taskStats)}`);
    }
  }
  return lines.join("\n");
}

/** Render an opaque task-stat value compactly for the terminal (objects → inline JSON). */
function fmtStatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
