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
  /**
   * Hidden reasoning trace, when the provider exposes it (e.g. OpenRouter
   * `message.reasoning`). Captured for post-mortem logging only — it is NEVER fed
   * back into the model's context. Often empty (models omit it by default, or it
   * is excluded). May be unfaithful to the model's true computation, so treat it
   * as diagnostic evidence, not ground truth.
   */
  reasoning?: string;
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
}

export interface LlmSendConfig {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /**
   * Reasoning effort for hybrid/reasoning models (mapped to the provider's
   * reasoning control, e.g. OpenRouter `reasoning.effort`). Bounds how much a
   * model "thinks" per turn so it stays fast and always emits a move instead of
   * burning the whole output budget on hidden reasoning. "off" disables thinking
   * entirely (maps to `reasoning.enabled: false`). "adaptive" turns thinking ON and
   * lets the model self-dose its depth (maps to `reasoning.enabled: true`) — this is
   * the only way to enable Claude Opus 4.7+ extended thinking over OpenRouter, since
   * effort levels are ignored on those models. Omitted ⇒ model default (often OFF).
   */
  reasoningEffort?: "off" | "adaptive" | "low" | "medium" | "high";
  /**
   * Output verbosity for models where temperature/reasoning.effort are not
   * effective (e.g. Claude Opus 4.7+). Maps to OpenRouter `verbosity` →
   * Anthropic `output_config.effort`. "low" cuts prose and accelerates tool
   * calls without reducing tactical reasoning depth. Omitted ⇒ model default.
   */
  verbosity?: "low" | "medium" | "high";
  /**
   * Maximum number of tokens the model may spend on internal reasoning
   * (maps to `reasoning.max_tokens` in the OpenRouter/Anthropic API).
   * Must be less than maxTokens — the remainder is reserved for the actual
   * response (tool call + text). Prevents the thinking budget from eating the
   * entire output window and producing a `finishReason: "length"` forfeit.
   * Omitted ⇒ uncapped (dangerous with adaptive thinking on complex positions).
   */
  reasoningBudget?: number;
}
