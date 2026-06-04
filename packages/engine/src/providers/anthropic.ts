import type {
  LlmMessage,
  LlmProvider,
  LlmResult,
  LlmSendConfig,
  ToolDefinition,
} from "@agentarena/types";
import { fetchWithRetry } from "./http.js";

/**
 * Anthropic provider (uses the Messages API).
 */
export class AnthropicProvider implements LlmProvider {
  readonly providerId: string;

  private readonly apiVersion = "2023-06-01";

  constructor(
    id: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string = "https://api.anthropic.com/v1",
  ) {
    this.providerId = id;
  }

  async send(
    messages: LlmMessage[],
    tools?: ToolDefinition[],
    config?: LlmSendConfig,
  ): Promise<LlmResult> {
    // Extract system message if present (Anthropic has a separate system param)
    let system: string | undefined;
    const msgs = messages.filter((m) => {
      if (m.role === "system") {
        system = m.content;
        return false;
      }
      return true;
    });

    const body: Record<string, unknown> = {
      model: this.model,
      messages: msgs.map((m) => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.toolCalls?.length) {
          msg.content = m.toolCalls.map((tc) => ({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          }));
        }
        return msg;
      }),
      max_tokens: config?.maxTokens ?? 4096,
    };
    if (system) body.system = system;
    if (tools?.length) {
      body.tools = tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const res = await fetchWithRetry(
      `${this.baseUrl}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": this.apiVersion,
        },
        body: JSON.stringify(body),
      },
      "Anthropic",
    );

    const json = (await res.json()) as {
      usage: { input_tokens: number; output_tokens: number };
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      stop_reason: string;
    };

    const toolCalls = json.content
      .filter((c) => c.type === "tool_use")
      .map((c) => ({
        id: c.id ?? "",
        type: "function" as const,
        function: {
          name: c.name ?? "",
          arguments: JSON.stringify(c.input ?? {}),
        },
      }));

    const textContent = json.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");

    return {
      content: textContent,
      toolCalls,
      tokensInput: json.usage.input_tokens,
      tokensOutput: json.usage.output_tokens,
      finishReason: json.stop_reason,
    };
  }
}
