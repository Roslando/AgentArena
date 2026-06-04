import type {
  LlmMessage,
  LlmProvider,
  LlmResult,
  LlmSendConfig,
  ToolDefinition,
} from "@agentarena/types";
import { fetchWithRetry } from "./http.js";

/**
 * Google Gemini provider (uses the chat completion endpoint).
 */
export class GoogleProvider implements LlmProvider {
  readonly providerId: string;

  constructor(
    id: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string = "https://generativelanguage.googleapis.com/v1beta",
  ) {
    this.providerId = id;
  }

  async send(
    messages: LlmMessage[],
    tools?: ToolDefinition[],
    config?: LlmSendConfig,
  ): Promise<LlmResult> {
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: config?.maxTokens ?? 4096,
      },
    };

    // System instruction
    const systemMsg = messages.find((m) => m.role === "system");
    if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };

    if (tools?.length) {
      body.tools = [
        {
          functionDeclarations: tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          })),
        },
      ];
    }

    const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      "Google",
    );

    const json = (await res.json()) as {
      candidates: Array<{
        content: {
          parts: Array<{
            text?: string;
            functionCall?: { name: string; args: Record<string, unknown> };
          }>;
        };
        finishReason: string;
      }>;
      usageMetadata?: {
        promptTokenCount: number;
        candidatesTokenCount: number;
      };
    };

    const candidate = json.candidates[0];
    if (!candidate) throw new Error("Google returned no candidates");

    const parts = candidate.content.parts;
    const textContent = parts
      .filter((p) => p.text)
      .map((p) => p.text ?? "")
      .join("\n");
    const toolCalls = parts
      .filter(
        (p): p is typeof p & { functionCall: NonNullable<typeof p.functionCall> } =>
          !!p.functionCall,
      )
      .map((p, i) => ({
        id: `fc_${i}`,
        type: "function" as const,
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args),
        },
      }));

    return {
      content: textContent,
      toolCalls,
      tokensInput: json.usageMetadata?.promptTokenCount ?? 0,
      tokensOutput: json.usageMetadata?.candidatesTokenCount ?? 0,
      finishReason: candidate.finishReason,
    };
  }
}
