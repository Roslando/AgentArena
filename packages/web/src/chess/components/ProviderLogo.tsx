/**
 * Rounded brand avatar for an LLM player.
 *
 * The brand is detected from the model name first (so a DeepSeek/Grok/Qwen model
 * served through an OpenAI-compatible endpoint still shows its real lab logo),
 * then falls back to the provider type. Logos are local SVGs in /public/logos
 * (from Lobe Icons, MIT) — no runtime network, no heavy dependency.
 */

// Brands we ship a logo for (file at /logos/<brand>.svg).
const BRANDS = [
  "openai",
  "anthropic",
  "gemini",
  "grok",
  "meta",
  "mistral",
  "deepseek",
  "qwen",
  "moonshot",
  "cohere",
  "microsoft",
  "amazon",
  "minimax",
  "ollama",
] as const;
type Brand = (typeof BRANDS)[number];

// Substring → brand, matched against the (lowercased) model name.
const MODEL_PATTERNS: Array<[RegExp, Brand]> = [
  [/claude/, "anthropic"],
  [/gpt|chatgpt|\bo[1-4]\b|davinci/, "openai"],
  [/gemini|palm|bison|gemma/, "gemini"],
  [/grok/, "grok"],
  [/llama/, "meta"],
  [/mi(s|x)tral|codestral|ministral/, "mistral"],
  [/deepseek/, "deepseek"],
  [/qwen|qwq/, "qwen"],
  [/kimi|moonshot/, "moonshot"],
  [/command|cohere/, "cohere"],
  [/copilot|phi-?\d/, "microsoft"],
  [/nova|titan|bedrock/, "amazon"],
  [/minimax|abab/, "minimax"],
];

// providerType → brand (fallback when the model name is unknown).
const PROVIDER_FALLBACK: Record<string, Brand> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "gemini",
  ollama: "ollama",
};

function detectBrand(provider: string, model?: string): Brand | null {
  const m = (model ?? "").toLowerCase();
  for (const [re, brand] of MODEL_PATTERNS) {
    if (re.test(m)) return brand;
  }
  return PROVIDER_FALLBACK[provider.toLowerCase()] ?? null;
}

export function ProviderLogo({
  provider,
  model,
  size = 28,
}: {
  provider: string;
  model?: string;
  size?: number;
}) {
  const brand = detectBrand(provider, model);

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-700/70 ring-1 ring-slate-600/50"
      style={{ width: size, height: size }}
      title={brand ?? provider}
    >
      {brand ? (
        <img
          src={`/logos/${brand}.svg`}
          alt={brand}
          width={Math.round(size * 0.62)}
          height={Math.round(size * 0.62)}
          draggable={false}
        />
      ) : (
        <span
          className="font-semibold text-slate-200"
          style={{ fontSize: Math.round(size * 0.42) }}
        >
          {(model ?? provider).charAt(0).toUpperCase()}
        </span>
      )}
    </span>
  );
}
