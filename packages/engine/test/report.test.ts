import type { LogEntry } from "@agentarena/types";
import { describe, expect, it } from "vitest";
import { buildReport, formatReport } from "../src/report.js";

// A winner-less generic task: Alpha is flawless + cheap + tight; Beta errs + costs more.
const log: LogEntry[] = [
  {
    type: "match.start",
    t: "",
    matchId: "m",
    players: [
      {
        id: "a",
        name: "Alpha",
        providerType: "openai",
        model: "gpt",
        priceInputPerM: 1,
        priceOutputPerM: 2,
      },
      {
        id: "b",
        name: "Beta",
        providerType: "openai",
        model: "claude",
        priceInputPerM: 5,
        priceOutputPerM: 10,
      },
    ],
  },
  {
    type: "match.summary",
    t: "",
    matchId: "m",
    matchDurationMs: 120_000,
    players: [
      {
        playerId: "a",
        turns: 10,
        totalLlmLatencyMs: 50_000,
        avgLlmLatencyMs: 5_000,
        totalTokensInput: 1_000,
        totalTokensOutput: 2_000,
        totalTokens: 3_000,
        toolCalls: 20,
        invalidActions: 0,
      },
      {
        playerId: "b",
        turns: 10,
        totalLlmLatencyMs: 80_000,
        avgLlmLatencyMs: 8_000,
        totalTokensInput: 2_000,
        totalTokensOutput: 5_000,
        totalTokens: 7_000,
        toolCalls: 40,
        invalidActions: 3,
      },
    ],
  },
  { type: "match.end", t: "", matchId: "m", reason: "game_over" }, // no winner declared
];

describe("buildReport", () => {
  it("derives per-model stats and recommends the better-fit model when no winner", () => {
    const r = buildReport(log);
    if (!r) throw new Error("expected a report");
    const a = r.players.find((p) => p.id === "a");
    const b = r.players.find((p) => p.id === "b");

    expect(r.winnerId).toBeNull();
    expect(a?.outcome).toBe("draw");
    expect(a?.errorRate).toBe(0);
    expect(a?.tokPerSec ?? 0).toBeCloseTo(40, 1); // 2000 tok ÷ 50s
    expect(a?.costUsd ?? -1).toBeCloseTo(0.001 * 1 + 0.002 * 2, 6); // tokens × prices
    expect(b?.invalidActions).toBe(3);
    expect(b?.errorRate ?? 0).toBeCloseTo(3 / 13, 4);

    // Alpha: flawless, cheaper, fewer redundant calls → higher composite → recommended.
    expect(r.recommendedId).toBe("a");
    expect((a?.composite ?? 0) > (b?.composite ?? 0)).toBe(true);
  });

  it("formats a winner-less report and names the recommendation", () => {
    const r = buildReport(log);
    if (!r) throw new Error("expected a report");
    const txt = formatReport(r);
    expect(txt).toContain("Recommended for this task: Alpha");
    expect(txt).toContain("Invalid actions");
    expect(txt).toContain("no winner");
  });

  it("returns null when the log has no match.summary", () => {
    expect(buildReport([{ type: "match.start", t: "", matchId: "m", players: [] }])).toBeNull();
  });
});
