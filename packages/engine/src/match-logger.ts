import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { LogEntry } from "@agentarena/types";

/**
 * Append-only, structured match logger.
 *
 * Every log entry is written as a JSONL line to a file named `<matchId>.jsonl`
 * inside the configured output directory. Disk writes are async and chained so
 * they never block the event loop yet still land in order; {@link flush} awaits
 * the queue before the process exits.
 */
export class MatchLogger {
  private readonly path: string;
  private count = 0;
  /** Serialized write chain: keeps the event loop free while preserving order. */
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * @param onEntry optional callback invoked (synchronously) as each entry is
   *   recorded — used by the live server to broadcast events over WebSocket.
   */
  constructor(
    matchId: string,
    outputDir?: string,
    private readonly onEntry?: (entry: LogEntry) => void,
  ) {
    const dir = outputDir ?? "logs";
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${matchId}.jsonl`);
    // Truncate any stale file for this id. The log is append-only WITHIN a match,
    // but a re-run of the same matchId starts a clean log instead of stacking
    // several matches in one file (which corrupts replay).
    writeFileSync(this.path, "");
  }

  /** Append a single entry to the immutable log. */
  write(entry: LogEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    this.count++;
    // Notify live subscribers synchronously so broadcast order is preserved...
    this.onEntry?.(entry);
    // ...but write to disk off the event loop, chained to keep file order.
    this.writeChain = this.writeChain.then(() =>
      appendFile(this.path, line).catch((err) => {
        console.error(`MatchLogger: failed to persist entry: ${err}`);
      }),
    );
  }

  /** Resolve once every queued write has hit disk. Call before process exit. */
  async flush(): Promise<void> {
    await this.writeChain;
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
