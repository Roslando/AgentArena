#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { MatchRunner } from "@agentarena/engine";
import { MatchConfigSchema } from "@agentarena/types";

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("Usage: agentarena <path/to/match.config.json>");
    process.exit(1);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    console.error(`Failed to read config: ${err}`);
    process.exit(1);
  }

  const parsed = MatchConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("Invalid match configuration:");
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  const runner = new MatchRunner(parsed.data);
  const result = await runner.run();

  console.log(JSON.stringify({ matchId: parsed.data.matchId, ...result }, null, 2));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
