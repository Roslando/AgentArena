/**
 * A tool definition as exposed to the LLM (OpenAI-compatible shape).
 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * A tool call returned by the LLM.
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Unified result from any LLM provider.
 */
export interface LlmResult {
  content: string;
  toolCalls: ToolCall[];
  tokensInput: number;
  tokensOutput: number;
  finishReason: string;
}

/**
 * Abstract interface every LLM provider must implement.
 *
 * The agent talks to providers through this interface only.
 */
export interface LlmProvider {
  readonly providerId: string;
  send(
    messages: LlmMessage[],
    tools?: ToolDefinition[],
    config?: LlmSendConfig,
  ): Promise<LlmResult>;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

export interface LlmSendConfig {
  maxTokens?: number;
  temperature?: number;
}
