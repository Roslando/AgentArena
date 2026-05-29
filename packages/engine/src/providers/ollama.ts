import { OpenAiProvider } from "./openai.js";

/**
 * Ollama provider — reuses the OpenAI-compatible provider with a different base URL.
 */
export class OllamaProvider extends OpenAiProvider {
  constructor(id: string, model: string, baseUrl = "http://localhost:11434/v1") {
    // Ollama doesn't need an API key
    super(id, "", model, baseUrl);
  }
}
