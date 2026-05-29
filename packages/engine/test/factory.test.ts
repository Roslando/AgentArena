import { describe, expect, it } from "vitest";
import { createProvider } from "../src/providers/factory.js";

describe("createProvider", () => {
  it("creates an OpenAI provider", () => {
    const p = createProvider("test", {
      type: "openai",
      apiKey: "sk-test",
      model: "gpt-4o",
    });
    expect(p.providerId).toBe("test");
  });

  it("creates an Anthropic provider", () => {
    const p = createProvider("test", {
      type: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-20250514",
    });
    expect(p.providerId).toBe("test");
  });

  it("creates a Google provider", () => {
    const p = createProvider("test", {
      type: "google",
      apiKey: "google-test",
      model: "gemini-2.0-flash",
    });
    expect(p.providerId).toBe("test");
  });

  it("creates an Ollama provider", () => {
    const p = createProvider("test", {
      type: "ollama",
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(p.providerId).toBe("test");
  });

  it("throws for unknown provider type", () => {
    expect(() => createProvider("test", { type: "unknown" } as never)).toThrow(
      "Unknown provider type",
    );
  });
});
