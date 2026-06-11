/**
 * Discriminated union of every event that can appear in the immutable match log.
 */
export type LogEntry =
  | McpConnectingEntry
  | McpConnectedEntry
  | McpDisconnectedEntry
  | McpErrorEntry
  | LlmSentEntry
  | LlmResponseEntry
  | LlmErrorEntry
  | ToolCallEntry
  | ToolResultEntry
  | ToolErrorEntry
  | GameOverEntry
  | ForfeitEntry
  | MatchStartEntry
  | MatchEndEntry
  | TurnMetricsEntry
  | MatchSummaryEntry;

interface BaseEntry {
  /** ISO-8601 timestamp */
  t: string;
  matchId: string;
  playerId?: string;
  /** Latency in ms, when applicable */
  latencyMs?: number;
}

// Re-export for internal use (match-runner needs to construct LogEntry)
export type { BaseEntry };

export interface McpConnectingEntry extends BaseEntry {
  type: "mcp.connecting";
  transport: string;
}

export interface McpConnectedEntry extends BaseEntry {
  type: "mcp.connected";
  tools: string[];
}

export interface McpDisconnectedEntry extends BaseEntry {
  type: "mcp.disconnected";
}

export interface McpErrorEntry extends BaseEntry {
  type: "mcp.error";
  message: string;
}

export interface LlmSentEntry extends BaseEntry {
  type: "llm.sent";
  /** Number of messages in the context sent */
  messageCount: number;
}

export interface LlmResponseEntry extends BaseEntry {
  type: "llm.response";
  content: string;
  tokensInput: number;
  tokensOutput: number;
  /** The raw finish reason from the provider */
  finishReason: string;
  /**
   * Hidden reasoning trace, when the provider exposes it (e.g. OpenRouter
   * `message.reasoning`). Logged for post-mortem analysis only; never fed back to
   * the model. Often absent. The UI ignores it (no chat bubble).
   */
  reasoning?: string;
}

export interface LlmErrorEntry extends BaseEntry {
  type: "llm.error";
  message: string;
}

export interface ToolCallEntry extends BaseEntry {
  type: "tool.call";
  toolName: string;
  args: Record<string, unknown>;
  attempt: number;
}

export interface ToolResultEntry extends BaseEntry {
  type: "tool.result";
  toolName: string;
  result: unknown;
}

export interface ToolErrorEntry extends BaseEntry {
  type: "tool.error";
  toolName: string;
  error: string;
  attempt: number;
}

export interface GameOverEntry extends BaseEntry {
  type: "game.over";
  result: Record<string, unknown>;
}

export interface ForfeitEntry extends BaseEntry {
  type: "forfeit";
  reason: string;
}

export interface MatchStartEntry extends BaseEntry {
  type: "match.start";
  /** Game identifier (e.g. "chess"), when known */
  game?: string;
  /** Sanitized player roster — no API keys — so the UI can show logos/names in live and replay */
  players: Array<{
    id: string;
    name: string;
    providerType: string;
    model: string;
    /** USD price per 1M input tokens, when configured (for live cost display) */
    priceInputPerM?: number;
    /** USD price per 1M output tokens, when configured (for live cost display) */
    priceOutputPerM?: number;
  }>;
}

export interface MatchEndEntry extends BaseEntry {
  type: "match.end";
  winnerId?: string;
  reason: string;
}

export interface TurnMetricsEntry extends BaseEntry {
  type: "turn_metrics";
  /** LLM API call duration — the "pure reflection time" (network + inference, no MCP overhead) */
  llmLatencyMs: number;
  /** MCP callTool() duration — infrastructure overhead, not reflection */
  mcpLatencyMs: number;
  /** Total wall time for the turn (LLM + MCP + minor overhead) */
  turnDurationMs: number;
  turnNumber: number;
}

export interface MatchSummaryEntry extends BaseEntry {
  type: "match.summary";
  /** Total match wall time in ms */
  matchDurationMs: number;
  players: Array<{
    playerId: string;
    /** Number of turns this player took */
    turns: number;
    /** Sum of LLM API latencies (pure reflection time) */
    totalLlmLatencyMs: number;
    /** Average LLM latency per turn */
    avgLlmLatencyMs: number;
    totalTokensInput: number;
    totalTokensOutput: number;
    /** Convenience: input + output */
    totalTokens: number;
  }>;
}
