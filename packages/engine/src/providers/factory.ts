import type { LlmProvider, ProviderConfig } from "@agentarena/types";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAiProvider } from "./openai.js";

export type ProviderFactory = (id: string, config: ProviderConfig) => LlmProvider;

const registry: Record<string, ProviderFactory> = {
  openai: (id, cfg) =>
    new OpenAiProvider(
      id,
      (cfg as { apiKey: string }).apiKey,
      cfg.model,
      (cfg as { baseUrl?: string }).baseUrl,
    ),
  anthropic: (id, cfg) =>
    new AnthropicProvider(
      id,
      (cfg as { apiKey: string }).apiKey,
      cfg.model,
      (cfg as { baseUrl?: string }).baseUrl,
    ),
  google: (id, cfg) =>
    new GoogleProvider(
      id,
      (cfg as { apiKey: string }).apiKey,
      cfg.model,
      (cfg as { baseUrl?: string }).baseUrl,
    ),
  ollama: (id, cfg) => new OllamaProvider(id, cfg.model, (cfg as { baseUrl: string }).baseUrl),
};

export function createProvider(id: string, config: ProviderConfig): LlmProvider {
  const factory = registry[config.type];
  if (!factory) throw new Error(`Unknown provider type: ${config.type}`);
  return factory(id, config);
}
