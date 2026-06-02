/** Minimal inline SVG marks for each provider — no external assets, no network. */
export function ProviderLogo({ provider, size = 28 }: { provider: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24" } as const;

  switch (provider) {
    case "anthropic":
      return (
        <svg {...common} aria-label="Anthropic" role="img">
          <rect width="24" height="24" rx="5" fill="#D97757" />
          <path
            d="M7 17 11 7h2l4 10h-2.2l-.9-2.4h-3.8L8.2 17H7Zm3.3-4.1h2.4L11.5 9l-1.2 3.9Z"
            fill="#fff"
          />
        </svg>
      );
    case "openai":
      return (
        <svg {...common} aria-label="OpenAI" role="img">
          <rect width="24" height="24" rx="5" fill="#10A37F" />
          <circle cx="12" cy="12" r="5.5" fill="none" stroke="#fff" strokeWidth="1.6" />
          <circle cx="12" cy="12" r="1.6" fill="#fff" />
        </svg>
      );
    case "google":
      return (
        <svg {...common} aria-label="Google" role="img">
          <rect width="24" height="24" rx="5" fill="#1A1A2E" />
          <path
            d="M12 7.2c1.3 0 2.4.5 3.2 1.2l-1.3 1.3c-.5-.4-1.1-.7-1.9-.7a3 3 0 1 0 0 6c1.6 0 2.5-.9 2.7-2.1H12v-1.8h4.6c.1.4.1.8.1 1.2 0 2.9-1.9 4.9-4.7 4.9a4.9 4.9 0 1 1 0-9.9Z"
            fill="#4285F4"
          />
        </svg>
      );
    default: // ollama / local
      return (
        <svg {...common} aria-label="Local model" role="img">
          <rect width="24" height="24" rx="5" fill="#3B3B52" />
          <circle cx="9" cy="12" r="2" fill="#fff" />
          <circle cx="15" cy="12" r="2" fill="#fff" />
        </svg>
      );
  }
}
