import type { MatchConfig } from "@agentarena/types";
import { ENV_KEY_BY_TYPE, resolveApiKey } from "./providers/factory.js";

/**
 * Validate a match config before anything expensive runs.
 *
 * Currently checks that every key-based provider has an API key resolvable
 * (from config or environment). Returns a list of human-readable problems;
 * an empty array means the config is ready. All problems are collected so the
 * user can fix them in one pass (fail-fast, report-all pattern).
 */
export function preflight(config: MatchConfig): string[] {
  const problems: string[] = [];

  for (const player of config.players) {
    const { type } = player.provider;
    if (type === "ollama") continue;
    if (!resolveApiKey(player.provider)) {
      const envVar = ENV_KEY_BY_TYPE[type];
      problems.push(
        `player "${player.id}" (${type}): no API key — set ${envVar} in .env or provider.apiKey in the config.`,
      );
    }
  }

  return problems;
}
