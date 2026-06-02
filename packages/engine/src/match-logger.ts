import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LogEntry } from "@agentarena/types";

/**
 * Append-only, structured match logger.
 *
 * Every log entry is written as a JSONL line to a file named `<matchId>.jsonl`
 * inside the configured output directory.
 */
export class MatchLogger {
  private readonly path: string;
  private count = 0;

  /**
   * @param onEntry optional callback invoked after each entry is persisted —
   *   used by the live server to broadcast events over WebSocket.
   */
  constructor(
    matchId: string,
    outputDir?: string,
    private readonly onEntry?: (entry: LogEntry) => void,
  ) {
    const dir = outputDir ?? "logs";
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${matchId}.jsonl`);
  }

  /** Append a single entry to the immutable log. */
  write(entry: LogEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.count++;
    this.onEntry?.(entry);
  }

  /** Number of entries written so far. */
  get size(): number {
    return this.count;
  }

  /** Absolute path to the log file. */
  get filePath(): string {
    return this.path;
  }
}
