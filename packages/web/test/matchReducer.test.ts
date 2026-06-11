import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LogEntry } from "@agentarena/types";
import { describe, expect, it } from "vitest";
import { foldEntries, matchReducer } from "../src/chess/state/matchReducer";
import { START_FEN, initialMatchState } from "../src/chess/state/types";

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

  it("shares one turn number across a read-then-move detour (get_board before make_move)", () => {
    // White inspects the board (get_board) and THEN moves: one chess move, two
    // llm.responses. Both bubbles must carry turn 1 — inspecting the board is not a
    // new turn — and White must not appear a turn "ahead" of Black. Regression
    // guard for the bug where every llm.response bumped the bubble's turn counter
    // (a player that read the board looked turns ahead of its opponent in the UI).
    const move = (san: string, from: string, to: string) =>
      JSON.stringify({ accepted: true, san, from, to });
    const entries: LogEntry[] = [
      {
        type: "match.start",
        t: "",
        matchId: "m",
        game: "chess",
        players: [
          { id: "w", name: "W", providerType: "openai", model: "x" },
          { id: "b", name: "B", providerType: "openai", model: "x" },
        ],
      },
      // White: a read-only get_board, then the actual move — one turn, two utterances.
      {
        type: "llm.response",
        t: "",
        matchId: "m",
        playerId: "w",
        content: "let me check the board",
        tokensInput: 1,
        tokensOutput: 1,
        finishReason: "tool_calls",
        latencyMs: 1,
      },
      {
        type: "tool.result",
        t: "",
        matchId: "m",
        playerId: "w",
        toolName: "get_board",
        result: {
          content: [{ type: "text", text: JSON.stringify({ fen: START_FEN, you_are: "white" }) }],
        },
      },
      {
        type: "llm.response",
        t: "",
        matchId: "m",
        playerId: "w",
        content: "now I play f3",
        tokensInput: 1,
        tokensOutput: 1,
        finishReason: "tool_calls",
        latencyMs: 1,
      },
      {
        type: "tool.result",
        t: "",
        matchId: "m",
        playerId: "w",
        toolName: "make_move",
        result: { content: [{ type: "text", text: move("f3", "f2", "f3") }] },
      },
      // Black: a single move.
      {
        type: "llm.response",
        t: "",
        matchId: "m",
        playerId: "b",
        content: "I reply e5",
        tokensInput: 1,
        tokensOutput: 1,
        finishReason: "tool_calls",
        latencyMs: 1,
      },
      {
        type: "tool.result",
        t: "",
        matchId: "m",
        playerId: "b",
        toolName: "make_move",
        result: { content: [{ type: "text", text: move("e5", "e7", "e5") }] },
      },
    ];

    const state = foldEntries(initialMatchState(), entries, entries.length);
    // White's read + move share turn 1 (one chess move); Black stays in lockstep at turn 1.
    expect(state.players[0]?.messages.map((m) => m.turn)).toEqual([1, 1]);
    expect(state.players[1]?.messages.map((m) => m.turn)).toEqual([1]);
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

  it("applies the post-move FEN and capture from an accepted make_move (no following get_board)", () => {
    // Regression guard: the game-ending move (and any blind stretch) is never followed by
    // a get_board snapshot, yet the board and material score must reflect it. The make_move
    // result now carries `fen` (and `captured`); the reducer must apply both WITHOUT
    // mistaking the move result for a board snapshot — which would wipe the trays and skip
    // the SAN timeline. A later snapshot then REPLACES the tray, so there is no double-count.
    const POST_FEN = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
    const start = {
      type: "match.start",
      t: "",
      matchId: "m",
      game: "chess",
      players: [
        { id: "w", name: "W", providerType: "openai", model: "x" },
        { id: "b", name: "B", providerType: "openai", model: "x" },
      ],
    } satisfies LogEntry;
    const captureMove: LogEntry = {
      type: "tool.result",
      t: "",
      matchId: "m",
      toolName: "make_move",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              accepted: true,
              fen: POST_FEN,
              san: "exd5",
              from: "e4",
              to: "d5",
              captured: "pawn",
            }),
          },
        ],
      },
    };
    const moved = foldEntries(initialMatchState(), [start, captureMove], 2);
    expect(moved.fen).toBe(POST_FEN); // board reflects the move, no get_board needed
    expect(moved.lastMove).toEqual({ from: "e4", to: "d5" });
    expect(moved.moves.map((m) => m.san)).toEqual(["exd5"]); // SAN timeline still advanced
    expect(moved.capturedByWhite).toEqual(["pawn"]); // White's capture counted on the move
    expect(moved.capturedByBlack).toEqual([]);

    // A later get_board snapshot REPLACES the tray (authoritative) — no double-count.
    const snapshot: LogEntry = {
      type: "tool.result",
      t: "",
      matchId: "m",
      toolName: "get_board",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              fen: POST_FEN,
              you_are: "black",
              captured_by_you: [],
              captured_by_opponent: ["pawn"],
            }),
          },
        ],
      },
    };
    const after = foldEntries(initialMatchState(), [start, captureMove, snapshot], 3);
    expect(after.capturedByWhite).toEqual(["pawn"]); // replaced, not ["pawn", "pawn"]
    expect(after.capturedByBlack).toEqual([]);
  });

  it("maps captured pieces to each colour's trophies (pieces it captured), regardless of perspective", () => {
    // Ground-truth convention (chess-game.ts): capturedPieces[color] = that color's
    // TROPHIES (the pieces IT captured); get_board exposes them as captured_by_you =
    // the pieces YOU captured. The reducer must therefore set capturedByWhite = the
    // pieces White captured (shown on White's side = bottom tray) and capturedByBlack =
    // the pieces Black captured. The mapping must not depend on whose get_board snapshot
    // it is. Regression guard for the inverted-trays/score bug.
    const getBoard = (youAre: "white" | "black", yourTrophies: string[], oppTrophies: string[]) =>
      ({
        type: "tool.result",
        t: "",
        matchId: "m",
        toolName: "get_board",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                fen: START_FEN,
                you_are: youAre,
                captured_by_you: yourTrophies,
                captured_by_opponent: oppTrophies,
              }),
            },
          ],
        },
      }) satisfies LogEntry;
    const start = {
      type: "match.start",
      t: "",
      matchId: "m",
      game: "chess",
      players: [
        { id: "w", name: "W", providerType: "openai", model: "x" },
        { id: "b", name: "B", providerType: "openai", model: "x" },
      ],
    } satisfies LogEntry;

    // White captured a knight; Black captured a pawn. Seen from White, then from Black.
    const fromWhite = foldEntries(
      initialMatchState(),
      [start, getBoard("white", ["knight"], ["pawn"])],
      2,
    );
    const fromBlack = foldEntries(
      initialMatchState(),
      [start, getBoard("black", ["pawn"], ["knight"])],
      2,
    );
    for (const s of [fromWhite, fromBlack]) {
      expect(s.capturedByWhite).toEqual(["knight"]); // pieces White captured → bottom tray
      expect(s.capturedByBlack).toEqual(["pawn"]); // pieces Black captured → top tray
    }
  });

  it("counts faults from illegal moves, including the forfeiting one get_board misses", () => {
    // An illegal make_move result (accepted:false) carries faults_total = the mover's
    // running fault count; the mover is the side to move (an illegal move doesn't advance
    // the SAN list). Regression guard: the final, forfeiting fault never appears in a
    // get_board snapshot — no turn follows it — so it must be read from the move result.
    const tr = (obj: object) =>
      ({
        type: "tool.result",
        t: "",
        matchId: "m",
        toolName: "make_move",
        result: { content: [{ type: "text", text: JSON.stringify(obj) }] },
      }) satisfies LogEntry;
    const start = {
      type: "match.start",
      t: "",
      matchId: "m",
      game: "chess",
      players: [
        { id: "w", name: "W", providerType: "openai", model: "x" },
        { id: "b", name: "B", providerType: "openai", model: "x" },
      ],
    } satisfies LogEntry;
    const entries: LogEntry[] = [
      start,
      tr({ accepted: false, fault: true, faults_total: 1, game_over: false }), // white (0 moves) → fault 1
      tr({ accepted: true, san: "e4", from: "e2", to: "e4" }), // white plays legal → black to move
      tr({ accepted: false, fault: true, faults_total: 1, game_over: false }), // black → fault 1
      tr({ accepted: false, fault: true, faults_total: 2, game_over: false }), // black → fault 2
      tr({ accepted: false, fault: true, faults_total: 3, game_over: true }), // black → fault 3 = forfeit
    ];
    const final = foldEntries(initialMatchState(), entries, entries.length);
    expect(final.players[0]?.faults).toBe(1); // white
    expect(final.players[1]?.faults).toBe(3); // black, incl. the forfeiting fault get_board never reported
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

  it("tracks faults from consecutive illegal make_move results", () => {
    const illegal = (faultsTotal: number) =>
      JSON.stringify({ accepted: false, fault: true, faults_total: faultsTotal });

    const entries: LogEntry[] = [
      {
        type: "match.start",
        t: "",
        matchId: "m",
        players: [
          { id: "w", name: "W", providerType: "openai", model: "x" },
          { id: "b", name: "B", providerType: "openai", model: "x" },
        ],
      },
      // White (moves.length === 0, parity = white) plays 3 illegal moves in a row
      {
        type: "tool.result",
        t: "",
        matchId: "m",
        toolName: "make_move",
        result: { content: [{ type: "text", text: illegal(1) }], isError: true },
      },
      {
        type: "tool.result",
        t: "",
        matchId: "m",
        toolName: "make_move",
        result: { content: [{ type: "text", text: illegal(2) }], isError: true },
      },
      {
        type: "tool.result",
        t: "",
        matchId: "m",
        toolName: "make_move",
        result: { content: [{ type: "text", text: illegal(3) }], isError: true },
      },
    ];

    const state = foldEntries(initialMatchState(), entries, entries.length);
    expect(state.players[0]?.faults).toBe(3); // white forfeited
    expect(state.players[1]?.faults).toBe(0); // black untouched
  });

  it("counts every tool call per player (agentic protocol signal)", () => {
    // Ideal is ~2 calls per move (observe via get_board, then make_move). White
    // follows it; Black plays blind (1 call, skipped the board read). The reducer
    // must tally tool.call entries per player so the report can score tool usage.
    const start = {
      type: "match.start",
      t: "",
      matchId: "m",
      players: [
        { id: "w", name: "W", providerType: "openai", model: "x" },
        { id: "b", name: "B", providerType: "openai", model: "x" },
      ],
    } satisfies LogEntry;
    const call = (playerId: string, toolName: string): LogEntry => ({
      type: "tool.call",
      t: "",
      matchId: "m",
      playerId,
      toolName,
      args: {},
      attempt: 1,
    });
    const entries: LogEntry[] = [
      start,
      call("w", "get_board"),
      call("w", "make_move"),
      call("b", "make_move"),
    ];
    const state = foldEntries(initialMatchState(), entries, entries.length);
    expect(state.players[0]?.toolCalls).toBe(2);
    expect(state.players[1]?.toolCalls).toBe(1);
  });

  it("skips empty-content responses in the chat thread but still counts them", () => {
    // A get_board read is a tool-only response with empty content (standard
    // function-calling). It must NOT create an empty chat bubble, but it is still a
    // real LLM call, so token/turn stats must accumulate. Regression guard.
    const resp = (content: string): LogEntry => ({
      type: "llm.response",
      t: "",
      matchId: "m",
      playerId: "w",
      content,
      tokensInput: 1,
      tokensOutput: 1,
      finishReason: "tool_calls",
      latencyMs: 5,
    });
    const entries: LogEntry[] = [
      {
        type: "match.start",
        t: "",
        matchId: "m",
        players: [
          { id: "w", name: "W", providerType: "openai", model: "x" },
          { id: "b", name: "B", providerType: "openai", model: "x" },
        ],
      },
      resp(""), // get_board read → empty content, no bubble
      resp("I play e4 to take the center."), // make_move → real bubble
    ];
    const state = foldEntries(initialMatchState(), entries, entries.length);
    const w = state.players[0];
    expect(w?.messages.map((m) => m.text)).toEqual(["I play e4 to take the center."]);
    expect(w?.turns).toBe(2); // both responses counted for stats
    expect(w?.tokensOutput).toBe(2);
  });

  it("ignores unknown/irrelevant entries without throwing", () => {
    const weird = { type: "mcp.connecting", t: "x", matchId: "m", transport: "stdio" } as LogEntry;
    const state = matchReducer(initialMatchState(), weird);
    expect(state.status).toBe("idle");
  });
});
