import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LogEntry } from "@agentarena/types";
import { describe, expect, it } from "vitest";
import { foldEntries, matchReducer } from "../src/chess/state/matchReducer";
import { initialMatchState, START_FEN } from "../src/chess/state/types";

const FIXTURE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures",
  "sample-foolsmate.jsonl",
);

function loadFixture(): LogEntry[] {
  return readFileSync(FIXTURE, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogEntry);
}

describe("matchReducer", () => {
  it("initializes players and colors on match.start", () => {
    const entries = loadFixture();
    const state = foldEntries(initialMatchState(), entries, 1);
    expect(state.status).toBe("live");
    expect(state.matchId).toBe("sample-foolsmate");
    expect(state.game).toBe("chess");
    expect(state.players).toHaveLength(2);
    expect(state.players[0]?.color).toBe("white");
    expect(state.players[1]?.color).toBe("black");
    expect(state.players[0]?.providerType).toBe("anthropic");
    expect(state.fen).toBe(START_FEN);
  });

  it("marks a player thinking on llm.sent and appends a chat message on llm.response", () => {
    const entries = loadFixture();
    // entry[1] = first get_board, entry[2] = llm.sent (white), entry[3] = llm.response
    const thinking = foldEntries(initialMatchState(), entries, 3);
    expect(thinking.players[0]?.thinking).toBe(true);

    const answered = foldEntries(initialMatchState(), entries, 4);
    expect(answered.players[0]?.thinking).toBe(false);
    expect(answered.players[0]?.messages).toHaveLength(1);
    expect(answered.players[0]?.messages[0]?.text).toContain("f3");
    expect(answered.players[0]?.messages[0]?.turn).toBe(1);
    expect(answered.players[0]?.turns).toBe(1);
    expect(answered.players[0]?.tokensOutput).toBeGreaterThan(0);
  });

  it("stacks every reasoning turn into the chat thread, oldest first", () => {
    const entries = loadFixture();
    const final = foldEntries(initialMatchState(), entries, entries.length);
    // White played twice (f3, g4) → two messages, in order.
    expect(final.players[0]?.messages.map((m) => m.turn)).toEqual([1, 2]);
    expect(final.players[0]?.messages).toHaveLength(2);
  });

  it("updates the board FEN from get_board tool results", () => {
    const entries = loadFixture();
    // Second get_board (white already played f3) reflects the new position
    const afterFirstMove = entries.findIndex(
      (e, i) =>
        e.type === "tool.result" &&
        i > 6 &&
        (e as { result?: { content?: { text?: string }[] } }).result?.content?.[0]?.text?.includes(
          '"you_are":"black"',
        ),
    );
    const state = foldEntries(initialMatchState(), entries, afterFirstMove + 1);
    expect(state.fen).not.toBe(START_FEN);
    expect(state.fen).toContain("5P2"); // f3 pawn
    expect(state.lastMove).toEqual({ from: "f2", to: "f3" });
  });

  it("appends accepted moves to the SAN timeline in order", () => {
    const entries = loadFixture();
    const final = foldEntries(initialMatchState(), entries, entries.length);
    expect(final.moves.map((m) => m.san)).toEqual(["f3", "e5", "g4", "Qh4#"]);
    expect(final.moves[0]?.color).toBe("white");
    expect(final.moves[1]?.color).toBe("black");
  });

  it("ends the match with the correct winner and aggregated stats", () => {
    const entries = loadFixture();
    const final = foldEntries(initialMatchState(), entries, entries.length);
    expect(final.status).toBe("over");
    expect(final.winnerId).toBe("black");
    expect(final.endReason).toBe("game_over");
    // match.summary overrode running stats
    expect(final.players[0]?.turns).toBe(2);
    expect(final.players[1]?.turns).toBe(2);
    expect(final.players.every((p) => !p.thinking)).toBe(true);
  });

  it("sets endReason only at match.end, not at the earlier game.over (report-ready signal)", () => {
    const entries = loadFixture();
    const gameOverIdx = entries.findIndex((e) => e.type === "game.over");
    expect(gameOverIdx).toBeGreaterThan(-1);

    // Folded through game.over: status is "over" but the match is NOT finalized yet —
    // the end report must stay hidden so the radar doesn't animate toward changing values.
    const atGameOver = foldEntries(initialMatchState(), entries, gameOverIdx + 1);
    expect(atGameOver.status).toBe("over");
    expect(atGameOver.endReason).toBeNull();

    // Folded through match.end: endReason is set → the report is ready with final data.
    const atEnd = foldEntries(initialMatchState(), entries, entries.length);
    expect(atEnd.endReason).not.toBeNull();
  });

  it("is pure — folding twice yields equal state (replay scrubbing safety)", () => {
    const entries = loadFixture();
    const a = foldEntries(initialMatchState(), entries, entries.length);
    const b = foldEntries(initialMatchState(), entries, entries.length);
    expect(a).toEqual(b);
  });

  it("ignores unknown/irrelevant entries without throwing", () => {
    const weird = { type: "mcp.connecting", t: "x", matchId: "m", transport: "stdio" } as LogEntry;
    const state = matchReducer(initialMatchState(), weird);
    expect(state.status).toBe("idle");
  });
});
