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
      messages: messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.toolCalls?.length) msg.tool_calls = m.toolCalls;
        return msg;
      }),
      max_tokens: config?.maxTokens ?? 4096,
    };
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
    };
  }
}
