import { z } from "zod";

/**
 * Configuration for an LLM provider.
 */
export const ProviderConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("openai"),
    apiKey: z.string(),
    model: z.string().default("gpt-4o"),
    baseUrl: z.string().optional(),
  }),
  z.object({
    type: z.literal("anthropic"),
    apiKey: z.string(),
    model: z.string().default("claude-sonnet-4-20250514"),
    baseUrl: z.string().optional(),
  }),
  z.object({
    type: z.literal("google"),
    apiKey: z.string(),
    model: z.string().default("gemini-2.0-flash"),
    baseUrl: z.string().optional(),
  }),
  z.object({
    type: z.literal("ollama"),
    model: z.string().default("llama3"),
    baseUrl: z.string().default("http://localhost:11434/v1"),
  }),
]);

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/**
 * Configuration for the MCP game server.
 */
export const McpServerConfigSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).optional(),
  }),
  z.object({
    transport: z.literal("sse"),
    url: z.string(),
  }),
]);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * A named player backed by an LLM provider.
 */
export const PlayerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: ProviderConfigSchema,
  systemPrompt: z.string().optional(),
  /** USD price per 1M input tokens (for live cost display). */
  priceInputPerM: z.number().nonnegative().optional(),
  /** USD price per 1M output tokens (for live cost display). */
  priceOutputPerM: z.number().nonnegative().optional(),
});

export type PlayerConfig = z.infer<typeof PlayerConfigSchema>;

/**
 * Arena-level limits for a match.
 */
export const MatchLimitsSchema = z.object({
  maxDurationMs: z.number().positive().default(300_000),
  maxRetriesPerTurn: z.number().int().positive().default(3),
  maxTokensPerTurn: z.number().int().positive().default(4096),
});

export type MatchLimits = z.infer<typeof MatchLimitsSchema>;

/**
 * Complete declarative match configuration, validated at runtime.
 */
export const MatchConfigSchema = z.object({
  matchId: z.string().min(1),
  players: z.array(PlayerConfigSchema).min(2).max(16),
  mcpServer: McpServerConfigSchema,
  limits: MatchLimitsSchema.default({}),
  stateToolName: z.string().default("get_state"),
});

export type MatchConfig = z.infer<typeof MatchConfigSchema>;
