import type {
  LlmMessage,
  LlmProvider,
  LlmResult,
  LlmSendConfig,
  ToolDefinition,
} from "@agentarena/types";
import { fetchWithRetry } from "./http.js";

/**
 * OpenAI-compatible provider (also serves as the base for Ollama).
 */
export class OpenAiProvider implements LlmProvider {
  readonly providerId: string;

  constructor(
    id: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string = "https://api.openai.com/v1",
  ) {
    this.providerId = id;
  }

  async send(
    messages: LlmMessage[],
    tools?: ToolDefinition[],
    config?: LlmSendConfig,
  ): Promise<LlmResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: config?.maxTokens ?? 4096,
    };
    if (config?.temperature !== undefined) body.temperature = config.temperature;
    if (config?.topP !== undefined) body.top_p = config.topP;
    const reasoningParams: Record<string, unknown> = {};
    if (config?.reasoningEffort === "off") reasoningParams.enabled = false;
    else if (config?.reasoningEffort === "adaptive") reasoningParams.enabled = true;
    else if (config?.reasoningEffort !== undefined) reasoningParams.effort = config.reasoningEffort;
    if (config?.reasoningBudget !== undefined) reasoningParams.max_tokens = config.reasoningBudget;
    if (Object.keys(reasoningParams).length) body.reasoning = reasoningParams;
    if (config?.verbosity !== undefined) body.verbosity = config.verbosity;
    if (tools?.length) body.tools = tools;

    const res = await fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      "OpenAI",
    );

    const json = (await res.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number };
      choices: [
        {
          message: {
            content: string | null;
            // OpenRouter exposes the hidden reasoning trace here when reasoning is
            // on and not excluded (string form, or structured reasoning_details).
            reasoning?: string | null;
            reasoning_details?: Array<{ text?: string; summary?: string }>;
            tool_calls?: Array<{
              id: string;
              type: "function";
              function: { name: string; arguments: string };
            }>;
          };
          finish_reason: string;
        },
      ];
    };

    const choice = json.choices[0];
    if (!choice) throw new Error("OpenAI returned no choices");
    const msg = choice.message;

    // Capture the reasoning trace for post-mortem logging (never re-fed to the model).
    let reasoning: string | undefined;
    if (typeof msg.reasoning === "string" && msg.reasoning.trim()) {
      reasoning = msg.reasoning;
    } else if (Array.isArray(msg.reasoning_details)) {
      const parts = msg.reasoning_details
        .map((d) => (typeof d?.text === "string" ? d.text : (d?.summary ?? "")))
        .filter((s): s is string => Boolean(s));
      if (parts.length) reasoning = parts.join("\n");
    }

    return {
      content: msg.content ?? "",
      toolCalls: (msg.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
      tokensInput: json.usage.prompt_tokens,
      tokensOutput: json.usage.completion_tokens,
      finishReason: choice.finish_reason,
      ...(reasoning ? { reasoning } : {}),
    };
  }
}
