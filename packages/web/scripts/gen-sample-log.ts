/**
 * Generate a realistic sample match log (no API keys needed) for UI replay + reducer tests.
 *
 * Plays Fool's mate (1. f3 e5 2. g4 Qh4#) with chess.js so every FEN/SAN is valid,
 * emitting events shaped exactly like the real MatchRunner output.
 *
 * Run: bun packages/web/scripts/gen-sample-log.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Chess } from "chess.js";

const MATCH_ID = "sample-foolsmate";
const PLAYERS = [
  { id: "white", name: "Claude Sonnet", providerType: "anthropic", model: "claude-sonnet-4" },
  { id: "black", name: "GPT-4o", providerType: "openai", model: "gpt-4o" },
];
const MOVES = ["f3", "e5", "g4", "Qh4#"]; // SAN, alternating white/black
const REASONING = [
  "I open with f3 to free my structure.",
  "I grab the center with e5.",
  "g4 expands on the kingside.",
  "Qh4 is checkmate — the king has no escape.",
];

const lines: string[] = [];
const t = (n: number) => new Date(Date.UTC(2026, 5, 1, 12, 0, n)).toISOString();
const push = (o: Record<string, unknown>) => lines.push(JSON.stringify(o));

const chess = new Chess();
let clock = 0;
const colorOf = (i: number): "white" | "black" => (i % 2 === 0 ? "white" : "black");

push({ type: "match.start", t: t(clock++), matchId: MATCH_ID, game: "chess", players: PLAYERS });

const captured = { white: [] as string[], black: [] as string[] };
const PIECE = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

for (let i = 0; i < MOVES.length; i++) {
  const mover = colorOf(i);
  const opponent = mover === "white" ? "black" : "white";
  const playerId = mover;

  // get_board for the player to move (board snapshot)
  const before = chess;
  const lastVerbose = before.history({ verbose: true }).at(-1);
  const boardJson = {
    fen: before.fen(),
    ascii: before.ascii(),
    you_are: mover,
    turn: mover,
    last_move_san: lastVerbose?.san ?? null,
    last_move_uci: lastVerbose ? `${lastVerbose.from}${lastVerbose.to}${lastVerbose.promotion ?? ""}` : null,
    captured_by_you: captured[mover],
    captured_by_opponent: captured[opponent],
    check: before.isCheck(),
    checkmate: before.isCheckmate(),
    stalemate: before.isStalemate(),
    your_faults: 0,
    opponent_faults: 0,
  };
  push({
    type: "tool.result",
    t: t(clock++),
    matchId: MATCH_ID,
    toolName: "get_board",
    result: { content: [{ type: "text", text: JSON.stringify(boardJson) }] },
    latencyMs: 4,
  });

  push({ type: "llm.sent", t: t(clock++), matchId: MATCH_ID, playerId, messageCount: 3 + i });

  const latency = 1200 + i * 250;
  push({
    type: "llm.response",
    t: t(clock++),
    matchId: MATCH_ID,
    playerId,
    content: REASONING[i],
    tokensInput: 420 + i * 30,
    tokensOutput: 18 + i * 4,
    finishReason: "tool_calls",
    latencyMs: latency,
  });

  // Apply the move
  const mv = chess.move(MOVES[i] as string);
  if (!mv) throw new Error(`Illegal SAN in fixture: ${MOVES[i]}`);
  if (mv.captured) captured[opponent].push(PIECE[mv.captured as keyof typeof PIECE]);

  push({
    type: "tool.call",
    t: t(clock++),
    matchId: MATCH_ID,
    playerId,
    toolName: "make_move",
    args: { move: `${mv.from}${mv.to}${mv.promotion ?? ""}` },
    attempt: 1,
  });

  const gameOver = chess.isGameOver();
  const moveJson = {
    accepted: true,
    san: mv.san,
    piece_moved: PIECE[mv.piece as keyof typeof PIECE],
    from: mv.from,
    to: mv.to,
    captured: mv.captured ? PIECE[mv.captured as keyof typeof PIECE] : null,
    promotion: mv.promotion ?? null,
    is_check: chess.isCheck(),
    is_checkmate: chess.isCheckmate(),
    is_stalemate: chess.isStalemate(),
    fault: false,
    faults_total: 0,
    forfeit: false,
    game_over: gameOver,
    result: gameOver ? `${mover} wins` : null,
    message: `Move played: ${mv.san}`,
  };
  const moveResult: Record<string, unknown> = {
    content: [{ type: "text", text: JSON.stringify(moveJson) }],
  };
  if (gameOver) {
    moveResult.gameOver = true;
    moveResult.winnerId = mover;
  }
  push({
    type: "tool.result",
    t: t(clock++),
    matchId: MATCH_ID,
    toolName: "make_move",
    result: moveResult,
    latencyMs: 3,
  });

  push({
    type: "turn_metrics",
    t: t(clock++),
    matchId: MATCH_ID,
    playerId,
    llmLatencyMs: latency,
    mcpLatencyMs: 7,
    turnDurationMs: latency + 12,
    turnNumber: i + 1,
  });

  if (gameOver) {
    push({
      type: "game.over",
      t: t(clock++),
      matchId: MATCH_ID,
      playerId,
      result: { game_over: true, winner_id: mover },
    });
    break;
  }
}

// Aggregated summary (mirrors MatchRunner.endMatch)
const summaryPlayers = PLAYERS.map((p, idx) => {
  const myMoves = MOVES.filter((_, i) => colorOf(i) === (idx === 0 ? "white" : "black"));
  const turns = myMoves.length;
  const totalLlm = myMoves.reduce((acc, _, k) => acc + (1200 + (idx + k * 2) * 250), 0);
  return {
    playerId: p.id,
    turns,
    totalLlmLatencyMs: totalLlm,
    avgLlmLatencyMs: turns ? Math.round(totalLlm / turns) : 0,
    totalTokensInput: 440 * turns,
    totalTokensOutput: 22 * turns,
    totalTokens: 462 * turns,
  };
});
push({
  type: "match.summary",
  t: t(clock++),
  matchId: MATCH_ID,
  matchDurationMs: clock * 1000,
  players: summaryPlayers,
});
push({ type: "match.end", t: t(clock++), matchId: MATCH_ID, reason: "game_over", winnerId: "black" });

// Write to both the repo logs/ dir and the web public/ dir (so the dev server can fetch it)
const out = `${lines.join("\n")}\n`;
mkdirSync("logs", { recursive: true });
writeFileSync(`logs/${MATCH_ID}.jsonl`, out);
mkdirSync("packages/web/public/samples", { recursive: true });
writeFileSync(`packages/web/public/samples/${MATCH_ID}.jsonl`, out);
mkdirSync("packages/web/test/fixtures", { recursive: true });
writeFileSync(`packages/web/test/fixtures/${MATCH_ID}.jsonl`, out);
console.log(`Wrote ${lines.length} entries → logs/, public/samples/, test/fixtures/`);
