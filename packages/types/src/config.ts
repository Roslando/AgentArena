import { z } from "zod";

/**
 * Configuration for an LLM provider.
 */
export const ProviderConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("openai"),
    // Optional override; by default the key is read from OPENAI_API_KEY.
    apiKey: z.string().optional(),
    model: z.string().default("gpt-4o"),
    baseUrl: z.string().optional(),
  }),
  z.object({
    type: z.literal("anthropic"),
    // Optional override; by default the key is read from ANTHROPIC_API_KEY.
    apiKey: z.string().optional(),
    model: z.string().default("claude-sonnet-4-20250514"),
    baseUrl: z.string().optional(),
  }),
  z.object({
    type: z.literal("google"),
    // Optional override; by default the key is read from GOOGLE_API_KEY.
    apiKey: z.string().optional(),
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
  /**
   * Per-player output cap. Overrides limits.maxTokensPerTurn for this player
   * only. Useful when models have opposite needs — e.g. a cheap model gets a
   * generous cap while an expensive one is kept low to fit a tight balance
   * (providers like OpenRouter pre-authorize max_tokens × price before running).
   */
  maxTokens: z.number().int().positive().optional(),
  /**
   * Sampling temperature. Set it per the model vendor's recommendation so each
   * agent runs as it would in everyday use (e.g. MiniMax recommends 1.0). When
   * omitted, the provider's own default applies.
   */
  temperature: z.number().min(0).max(2).optional(),
  /**
   * Nucleus sampling cutoff (top_p). Same intent as temperature — match the
   * vendor's recommendation (e.g. MiniMax 0.95). Omitted ⇒ provider default.
   */
  topP: z.number().min(0).max(1).optional(),
  /**
   * Reasoning effort for hybrid/reasoning models (e.g. MiniMax M3, which ramps
   * its hidden reasoning until it can blow the whole output budget on a single
   * move). "low"|"medium"|"high" bounds the thinking; "off" disables it entirely
   * (non-thinking mode); "adaptive" turns thinking ON with model-chosen depth (the
   * only lever for Claude Opus 4.7+, which ignores effort levels). Omitted ⇒ model
   * default (often OFF for Opus 4.7+).
   */
  reasoningEffort: z.enum(["off", "adaptive", "low", "medium", "high"]).optional(),
  /**
   * Output verbosity for models where temperature/reasoning.effort are not
   * effective (e.g. Claude Opus 4.7+). Maps to OpenRouter `verbosity` →
   * Anthropic `output_config.effort`. "low" cuts prose and accelerates tool
   * calls without reducing tactical depth. Omitted ⇒ model default.
   */
  verbosity: z.enum(["low", "medium", "high"]).optional(),
  /**
   * Maximum reasoning tokens (`reasoning.max_tokens`). Must be less than
   * maxTokens — reserves the remainder for the actual tool call + text so the
   * model never forfeits with `finishReason: "length"`. Essential for Claude
   * Opus 4.7+ in adaptive mode on complex positions. Omitted ⇒ uncapped.
   */
  reasoningBudget: z.number().int().positive().optional(),
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
  /**
   * Optional global wall-clock cap (ms). Omit it for no time limit — a match
   * then ends only on a real game outcome (checkmate, draw) or a forfeit, never
   * on the clock. Set it only if you deliberately want to bound match length.
   */
  maxDurationMs: z.number().positive().optional(),
  maxRetriesPerTurn: z.number().int().positive().default(3),
  maxTokensPerTurn: z.number().int().positive().default(8192),
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
