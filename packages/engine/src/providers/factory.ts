import type { LlmProvider, ProviderConfig } from "@agentarena/types";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAiProvider } from "./openai.js";

export type ProviderFactory = (id: string, config: ProviderConfig) => LlmProvider;

/** Environment variable holding the API key for each key-based provider. */
export const ENV_KEY_BY_TYPE: Record<"openai" | "anthropic" | "google", string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
};

/**
 * Resolve the API key for a provider: explicit `apiKey` in config wins,
 * otherwise fall back to the matching environment variable (Bun auto-loads .env).
 * Returns undefined for ollama (no key) or when nothing is set.
 */
export function resolveApiKey(config: ProviderConfig): string | undefined {
  if (config.type === "ollama") return undefined;
  const fromConfig = (config as { apiKey?: string }).apiKey;
  return fromConfig ?? process.env[ENV_KEY_BY_TYPE[config.type]];
}

const registry: Record<string, ProviderFactory> = {
  openai: (id, cfg) =>
    new OpenAiProvider(
      id,
      resolveApiKey(cfg) ?? "",
      cfg.model,
      (cfg as { baseUrl?: string }).baseUrl,
    ),
  anthropic: (id, cfg) =>
    new AnthropicProvider(
      id,
      resolveApiKey(cfg) ?? "",
      cfg.model,
      (cfg as { baseUrl?: string }).baseUrl,
    ),
  google: (id, cfg) =>
    new GoogleProvider(
      id,
      resolveApiKey(cfg) ?? "",
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
