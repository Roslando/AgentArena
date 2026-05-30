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
  | TurnMetricsEntry;

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
  tokensInput: number;
}

export interface LlmResponseEntry extends BaseEntry {
  type: "llm.response";
  content: string;
  tokensInput: number;
  tokensOutput: number;
  /** The raw finish reason from the provider */
  finishReason: string;
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
}

export interface MatchEndEntry extends BaseEntry {
  type: "match.end";
  winnerId?: string;
  reason: string;
}

export interface TurnMetricsEntry extends BaseEntry {
  type: "turn_metrics";
  thinkingTimeMs: number;
  totalThinkingTimeMs: number;
  turnNumber: number;
}
