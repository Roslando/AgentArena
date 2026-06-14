#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MatchRunner, buildReport, formatReport, preflight } from "@agentarena/engine";
import { type LogEntry, type MatchConfig, MatchConfigSchema } from "@agentarena/types";

const DEFAULT_CONFIG = "agentarena.config.json";
const PORT = Number(process.env.PORT ?? 7070);
const LOGS_DIR = process.env.LOGS_DIR ?? "logs";
const SERVER_ENTRY = resolve(process.cwd(), "packages/server/src/index.ts");
const WEB_INDEX = resolve(process.cwd(), "packages/web/dist/index.html");

/** Read, validate and preflight a match config. Exits the process on any failure. */
function loadConfig(configPath: string): MatchConfig {
  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    console.error("Tip: cp agentarena.config.example.json agentarena.config.json");
    console.error("Usage: agentarena [path/to/match.config.json]");
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

  const problems = preflight(parsed.data);
  if (problems.length > 0) {
    console.error("Preflight failed:");
    for (const p of problems) console.error(`  FAIL: ${p}`);
    process.exit(1);
  }

  return parsed.data;
}

/** Parse a saved .jsonl log (by matchId in the logs dir, or an explicit path). */
function loadLog(idOrPath: string): LogEntry[] {
  const path = idOrPath.endsWith(".jsonl")
    ? resolve(process.cwd(), idOrPath)
    : join(LOGS_DIR, `${idOrPath}.jsonl`);
  if (!existsSync(path)) {
    console.error(`Log not found: ${path}`);
    process.exit(1);
  }
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogEntry);
}

/** `agentarena report <matchId|path.jsonl> [--json]` — the per-model decision artifact. */
function reportCommand(idOrPath: string, asJson: boolean): void {
  const report = buildReport(loadLog(idOrPath));
  if (!report) {
    console.error("No match.summary found in this log — cannot build a report.");
    process.exit(1);
  }
  console.log(asJson ? JSON.stringify(report, null, 2) : formatReport(report));
}

/** `agentarena list` — the registry of available MCP servers (games/tasks). */
function listCommand(): void {
  const mcpsDir = resolve(process.cwd(), "packages/mcps");
  if (!existsSync(mcpsDir)) {
    console.log("No packages/mcps directory found.");
    return;
  }
  const dirs = readdirSync(mcpsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  console.log("Available MCP servers (tasks):\n");
  for (const d of dirs) {
    const pkgPath = join(mcpsDir, d.name, "package.json");
    let name = d.name;
    let description = "";
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          name?: string;
          description?: string;
        };
        name = pkg.name ?? d.name;
        description = pkg.description ?? "";
      } catch {
        // ignore an unreadable package.json — still list the folder
      }
    }
    console.log(`  ${d.name.padEnd(16)} ${name}${description ? ` — ${description}` : ""}`);
  }
  console.log("\nPoint a match config's mcpServer at one, then run: agentarena <config>");
}

/** Headless: run the match in-process, then print the per-model agentic report. */
async function runHeadless(config: MatchConfig): Promise<void> {
  const entries: LogEntry[] = [];
  const runner = new MatchRunner(config, (e) => entries.push(e));
  await runner.run();
  // Disk writes are async; make sure the log is fully flushed before we exit.
  await runner.logger.flush();
  const report = buildReport(entries);
  if (report) console.log(`\n${formatReport(report)}`);
}

/** Poll the server until it answers, so we POST the match only once it is ready. */
async function waitForServer(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server did not start on port ${PORT} within ${timeoutMs}ms`);
}

/** Open a URL in the default browser, cross-platform. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
}

/** Boot the whole stack: server + dashboard, then run the match live. */
async function runFullStack(config: MatchConfig): Promise<void> {
  if (!existsSync(WEB_INDEX)) {
    console.error("Dashboard not built. Run `bun run build` first.");
    process.exit(1);
  }

  const server = Bun.spawn(["bun", SERVER_ENTRY], {
    env: { ...process.env, SERVE_WEB: "1", PORT: String(PORT) },
    stdout: "inherit",
    stderr: "inherit",
  });

  const stop = () => {
    server.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await waitForServer();

  const res = await fetch(`http://localhost:${PORT}/api/matches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    console.error("Failed to start match:", await res.text());
    server.kill();
    process.exit(1);
  }

  const url = `http://localhost:${PORT}/?live=${config.matchId}`;
  console.log(`\nMatch live → ${url}\nPress Ctrl+C to stop.\n`);
  openBrowser(url);

  await server.exited;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // `agentarena list` — registry of available MCP servers.
  if (cmd === "list") {
    listCommand();
    return;
  }

  // `agentarena report <matchId|path.jsonl> [--json]` — stats from a saved log.
  if (cmd === "report") {
    const target = args.slice(1).find((a) => !a.startsWith("--"));
    if (!target) {
      console.error("Usage: agentarena report <matchId|path.jsonl> [--json]");
      process.exit(1);
    }
    reportCommand(target, args.includes("--json"));
    return;
  }

  // Default: run a match — `agentarena [config] [--headless]`.
  const headless = args.includes("--headless");
  const configPath = resolve(
    process.cwd(),
    args.find((a) => !a.startsWith("--")) ?? DEFAULT_CONFIG,
  );
  const config = loadConfig(configPath);

  if (headless) await runHeadless(config);
  else await runFullStack(config);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
