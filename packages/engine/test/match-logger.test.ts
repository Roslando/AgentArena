import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MatchLogger } from "../src/match-logger.js";

describe("MatchLogger", () => {
  let tmpDir: string;
  let logger: MatchLogger;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agentarena-test-"));
    logger = new MatchLogger("test-match", tmpDir);
  });

  it("writes entries as JSONL", async () => {
    logger.write({
      type: "match.start",
      t: new Date().toISOString(),
      matchId: "test-match",
    });
    await logger.flush();

    const content = readFileSync(join(tmpDir, "test-match.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("match.start");
    expect(parsed.matchId).toBe("test-match");
  });

  it("tracks entry count", () => {
    expect(logger.size).toBe(0);
    logger.write({
      type: "match.start",
      t: new Date().toISOString(),
      matchId: "test-match",
    });
    expect(logger.size).toBe(1);
    logger.write({
      type: "match.end",
      t: new Date().toISOString(),
      matchId: "test-match",
      reason: "game_over",
    });
    expect(logger.size).toBe(2);
  });

  it("returns the file path", () => {
    expect(logger.filePath).toBe(join(tmpDir, "test-match.jsonl"));
  });

  it("creates the output directory if it doesn't exist", () => {
    const nestedDir = join(tmpDir, "nested", "logs");
    const l = new MatchLogger("nested-match", nestedDir);
    expect(existsSync(nestedDir)).toBe(true);

    l.write({
      type: "match.start",
      t: new Date().toISOString(),
      matchId: "nested-match",
    });
    expect(existsSync(join(nestedDir, "nested-match.jsonl"))).toBe(true);
  });

  it("truncates a stale file when a new logger reuses the same matchId", async () => {
    logger.write({ type: "match.start", t: new Date().toISOString(), matchId: "test-match" });
    await logger.flush();

    // A re-run of the same id must start clean, not append to the previous match.
    const rerun = new MatchLogger("test-match", tmpDir);
    rerun.write({
      type: "match.end",
      t: new Date().toISOString(),
      matchId: "test-match",
      reason: "game_over",
    });
    await rerun.flush();

    const lines = readFileSync(join(tmpDir, "test-match.jsonl"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).type).toBe("match.end");
  });
});
