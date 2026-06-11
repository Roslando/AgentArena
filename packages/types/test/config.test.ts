import { describe, expect, it } from "vitest";
import { MatchConfigSchema } from "../src/config.js";

describe("MatchConfigSchema", () => {
  const validConfig = {
    matchId: "test-match",
    players: [
      {
        id: "player-1",
        name: "Alice",
        provider: { type: "openai" as const, apiKey: "sk-test", model: "gpt-4o" },
      },
      {
        id: "player-2",
        name: "Bob",
        provider: {
          type: "anthropic" as const,
          apiKey: "sk-ant-test",
          model: "claude-sonnet-4-20250514",
        },
      },
    ],
    mcpServer: {
      transport: "stdio" as const,
      command: "node",
      args: ["server.js"],
    },
  };

  it("accepts a valid minimal config", () => {
    const result = MatchConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it("accepts a config with explicit limits", () => {
    const result = MatchConfigSchema.safeParse({
      ...validConfig,
      limits: { maxDurationMs: 600_000, maxRetriesPerTurn: 5, maxTokensPerTurn: 8192 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a per-player maxTokens override", () => {
    const result = MatchConfigSchema.safeParse({
      ...validConfig,
      players: [{ ...validConfig.players[0], maxTokens: 768 }, validConfig.players[1]],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.players[0]?.maxTokens).toBe(768);
  });

  it("accepts per-player sampling settings (temperature and topP)", () => {
    const result = MatchConfigSchema.safeParse({
      ...validConfig,
      players: [{ ...validConfig.players[0], temperature: 1, topP: 0.95 }, validConfig.players[1]],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.players[0]?.temperature).toBe(1);
      expect(result.data.players[0]?.topP).toBe(0.95);
    }
  });

  it("accepts a per-player reasoningEffort", () => {
    const result = MatchConfigSchema.safeParse({
      ...validConfig,
      players: [{ ...validConfig.players[0], reasoningEffort: "medium" }, validConfig.players[1]],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.players[0]?.reasoningEffort).toBe("medium");
  });

  it("accepts reasoningEffort 'adaptive' (enables thinking on Opus 4.7+)", () => {
    const result = MatchConfigSchema.safeParse({
      ...validConfig,
      players: [{ ...validConfig.players[0], reasoningEffort: "adaptive" }, validConfig.players[1]],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.players[0]?.reasoningEffort).toBe("adaptive");
  });

  it("rejects an invalid reasoningEffort", () => {
    const result = MatchConfigSchema.safeParse({
      ...validConfig,
      players: [{ ...validConfig.players[0], reasoningEffort: "ultra" }, validConfig.players[1]],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a per-player verbosity", () => {
    const result = MatchConfigSchema.safeParse({
      ...validConfig,
      players: [{ ...validConfig.players[0], verbosity: "low" }, validConfig.players[1]],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.players[0]?.verbosity).toBe("low");
  });

  it("rejects an invalid verbosity", () => {
    const result = MatchConfigSchema.safeParse({
      ...validConfig,
      players: [{ ...validConfig.players[0], verbosity: "ultra" }, validConfig.players[1]],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a config with only 1 player", () => {
    const result = MatchConfigSchema.safeParse({
      ...validConfig,
      players: [validConfig.players[0]],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a config with 17 players", () => {
    const result = MatchConfigSchema.safeParse({
      ...validConfig,
      players: Array.from({ length: 17 }, (_, i) => ({
        id: `p-${i}`,
        name: `Player ${i}`,
        provider: { type: "openai" as const, apiKey: "sk-test" },
      })),
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown provider type", () => {
    const result = MatchConfigSchema.safeParse({
      ...validConfig,
      players: [
        {
          ...validConfig.players[0],
          provider: { type: "unknown", apiKey: "test" },
        },
        validConfig.players[1],
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts an SSE transport config", () => {
    const result = MatchConfigSchema.safeParse({
      ...validConfig,
      mcpServer: { transport: "sse", url: "http://localhost:3000/sse" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts ollama provider without apiKey", () => {
    const result = MatchConfigSchema.safeParse({
      ...validConfig,
      players: [
        {
          id: "ollama-player",
          name: "Local",
          provider: { type: "ollama", model: "llama3", baseUrl: "http://localhost:11434/v1" },
        },
        validConfig.players[1],
      ],
    });
    expect(result.success).toBe(true);
  });

  it("applies defaults for limits", () => {
    const result = MatchConfigSchema.parse(validConfig);
    expect(result.limits.maxDurationMs).toBeUndefined(); // no time cap by default
    expect(result.limits.maxRetriesPerTurn).toBe(3);
    expect(result.limits.maxTokensPerTurn).toBe(8192);
  });

  it("rejects empty player id", () => {
    const result = MatchConfigSchema.safeParse({
      ...validConfig,
      players: [{ ...validConfig.players[0], id: "" }, validConfig.players[1]],
    });
    expect(result.success).toBe(false);
  });
});
