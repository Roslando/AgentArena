/**
 * Generate a RICH showcase match log (no API keys) to exercise the full UI:
 * many captures (the material score moves), a long chat (scroll + "new message"
 * pill), a check, castling, one illegal-move fault with retry, and a checkmate.
 *
 * Game: Morphy's "Opera Game" (Paris, 1858). Every FEN/SAN is validated by chess.js
 * and events are shaped exactly like the real MatchRunner output.
 *
 * Run: bun packages/web/scripts/gen-showcase-log.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Chess } from "chess.js";

const MATCH_ID = "sample-showcase";
const PLAYERS = [
  // priceInputPerM / priceOutputPerM = USD per 1M tokens (drives the live cost chip).
  {
    id: "white",
    name: "Claude Opus",
    providerType: "anthropic",
    model: "claude-opus-4",
    priceInputPerM: 15,
    priceOutputPerM: 75,
  },
  {
    id: "black",
    name: "Gemini 2.5 Pro",
    providerType: "google",
    model: "gemini-2.5-pro",
    priceInputPerM: 1.25,
    priceOutputPerM: 10,
  },
];

// SAN, alternating white/black.
const MOVES = [
  "e4",
  "e5",
  "Nf3",
  "d6",
  "d4",
  "Bg4",
  "dxe5",
  "Bxf3",
  "Qxf3",
  "dxe5",
  "Bc4",
  "Nf6",
  "Qb3",
  "Qe7",
  "Nc3",
  "c6",
  "Bg5",
  "b5",
  "Nxb5",
  "cxb5",
  "Bxb5+",
  "Nbd7",
  "O-O-O",
  "Rd8",
  "Rxd7",
  "Rxd7",
  "Rd1",
  "Qe6",
  "Bxd7+",
  "Nxd7",
  "Qb8+",
  "Nxb8",
  "Rd8#",
];

const REASONING = [
  "King's pawn — claim the center immediately.",
  "Symmetry with e5, contesting the center.",
  "Develop the knight and pressure e5.",
  "Philidor setup, defending e5 solidly.",
  "Strike the center before Black consolidates.",
  "Pin the knight to ease the central tension.",
  "Open the position while the pin is loose.",
  "Trade off to break the pin on my knight.",
  "Recapture with the queen, eyeing f7.",
  "Restore material and keep a pawn on e5.",
  "That rook is blocked — bishop to c4, straight at f7.", // corrected move after the fault
  "Develop and shield the f7 square.",
  "Double the pressure on f7 and b7.",
  "Defend f7 and connect the pieces.",
  "Bring the last minor piece into play.",
  "Cover b5 and prepare to expand.",
  "Pin the knight and tighten the bind.",
  "Hit the bishop and grab some space.",
  "A knight sacrifice to rip open the center.",
  "Accept the piece — I'm up material now.",
  "Check, dragging the defense apart.",
  "Block the check and hold things together.",
  "Castle long, piling onto the d-file.",
  "Contest the d-file and shield the king.",
  "Demolish the defender with a rook sacrifice.",
  "Recapture — I must keep fighting.",
  "Bring the second rook to pin again.",
  "Defend d7 and cover the key squares.",
  "Another strike, peeling away the guard.",
  "Recapture and hope it holds.",
  "A queen sacrifice to finish the king.",
  "Forced — but it walks into mate.",
  "Rd8 is checkmate. A flawless miniature.",
];

// Inject one illegal-move fault to showcase the retry behaviour.
const FAULT_PLY = 10; // White's Bc4
const FAULT_BAD_MOVE = "a1a5"; // rook blocked by its own pawn → illegal
const FAULT_BAD_REASONING = "Lift the a1-rook to a5 for early pressure.";

const lines: string[] = [];
const t = (n: number) => new Date(Date.UTC(2026, 5, 1, 12, 0, n)).toISOString();
const push = (o: Record<string, unknown>) => lines.push(JSON.stringify(o));

const chess = new Chess();
let clock = 0;
const colorOf = (i: number): "white" | "black" => (i % 2 === 0 ? "white" : "black");

push({ type: "match.start", t: t(clock++), matchId: MATCH_ID, game: "chess", players: PLAYERS });

const captured = { white: [] as string[], black: [] as string[] }; // pieces each color captured (its trophies)
const faults = { white: 0, black: 0 };
const PIECE = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const named = (c: string) => PIECE[c as keyof typeof PIECE] ?? c;

// Running per-player stats (mirrors MatchRunner accumulation).
const stats: Record<
  string,
  { turns: number; tokIn: number; tokOut: number; llm: number; resp: number }
> = {
  white: { turns: 0, tokIn: 0, tokOut: 0, llm: 0, resp: 0 },
  black: { turns: 0, tokIn: 0, tokOut: 0, llm: 0, resp: 0 },
};

const emitResponse = (playerId: string, i: number, content: string) => {
  push({ type: "llm.sent", t: t(clock++), matchId: MATCH_ID, playerId, messageCount: 3 + i });
  const latency = 1100 + ((i * 137) % 1600); // varied, realistic-looking
  const tokIn = 380 + i * 24;
  const tokOut = 16 + ((i * 7) % 40);
  push({
    type: "llm.response",
    t: t(clock++),
    matchId: MATCH_ID,
    playerId,
    content,
    tokensInput: tokIn,
    tokensOutput: tokOut,
    finishReason: "tool_calls",
    latencyMs: latency,
  });
  const s = stats[playerId];
  if (s) {
    s.tokIn += tokIn;
    s.tokOut += tokOut;
    s.llm += latency;
    s.resp += 1;
  }
  return latency;
};

for (let i = 0; i < MOVES.length; i++) {
  const mover = colorOf(i);
  const opponent = mover === "white" ? "black" : "white";
  const playerId = mover;

  // get_board snapshot for the player to move
  const lastVerbose = chess.history({ verbose: true }).at(-1);
  const boardJson = {
    fen: chess.fen(),
    ascii: chess.ascii(),
    you_are: mover,
    turn: mover,
    last_move_san: lastVerbose?.san ?? null,
    last_move_uci: lastVerbose
      ? `${lastVerbose.from}${lastVerbose.to}${lastVerbose.promotion ?? ""}`
      : null,
    captured_by_you: captured[mover], // server convention: the pieces you captured
    captured_by_opponent: captured[opponent],
    check: chess.isCheck(),
    checkmate: chess.isCheckmate(),
    stalemate: chess.isStalemate(),
    your_faults: faults[mover],
    opponent_faults: faults[opponent],
  };
  push({
    type: "tool.result",
    t: t(clock++),
    matchId: MATCH_ID,
    toolName: "get_board",
    result: { content: [{ type: "text", text: JSON.stringify(boardJson) }] },
    latencyMs: 4,
  });

  // Fault demo: one rejected attempt before the real move.
  if (i === FAULT_PLY) {
    emitResponse(playerId, i, FAULT_BAD_REASONING);
    push({
      type: "tool.call",
      t: t(clock++),
      matchId: MATCH_ID,
      playerId,
      toolName: "make_move",
      args: { move: FAULT_BAD_MOVE },
      attempt: 1,
    });
    faults[mover] += 1;
    const rejectJson = {
      accepted: false,
      san: null,
      fault: true,
      faults_total: faults[mover],
      forfeit: false,
      game_over: false,
      message: `Illegal move. Faults: ${faults[mover]}/3. Try a different legal move.`,
    };
    push({
      type: "tool.result",
      t: t(clock++),
      matchId: MATCH_ID,
      toolName: "make_move",
      result: { content: [{ type: "text", text: JSON.stringify(rejectJson) }] },
      latencyMs: 3,
    });
  }

  // Real (accepted) move
  const attempt = i === FAULT_PLY ? 2 : 1;
  const latency = emitResponse(playerId, i, REASONING[i] as string);

  const mv = chess.move(MOVES[i] as string);
  if (!mv) throw new Error(`Illegal SAN in showcase: ${MOVES[i]}`);
  if (mv.captured) captured[mover].push(named(mv.captured)); // trophy goes to the capturing side
  const ms = stats[mover];
  if (ms) ms.turns += 1;

  push({
    type: "tool.call",
    t: t(clock++),
    matchId: MATCH_ID,
    playerId,
    toolName: "make_move",
    args: { move: `${mv.from}${mv.to}${mv.promotion ?? ""}` },
    attempt,
  });

  const gameOver = chess.isGameOver();
  const moveJson = {
    accepted: true,
    san: mv.san,
    piece_moved: named(mv.piece),
    from: mv.from,
    to: mv.to,
    captured: mv.captured ? named(mv.captured) : null,
    promotion: mv.promotion ?? null,
    is_check: chess.isCheck(),
    is_checkmate: chess.isCheckmate(),
    is_stalemate: chess.isStalemate(),
    fault: false,
    faults_total: faults[mover],
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
const summaryPlayers = PLAYERS.map((p) => {
  const s = stats[p.id] ?? { turns: 0, tokIn: 0, tokOut: 0, llm: 0, resp: 0 };
  return {
    playerId: p.id,
    turns: s.turns,
    totalLlmLatencyMs: s.llm,
    avgLlmLatencyMs: s.resp ? Math.round(s.llm / s.resp) : 0,
    totalTokensInput: s.tokIn,
    totalTokensOutput: s.tokOut,
    totalTokens: s.tokIn + s.tokOut,
  };
});
push({
  type: "match.summary",
  t: t(clock++),
  matchId: MATCH_ID,
  matchDurationMs: clock * 1000,
  players: summaryPlayers,
});
push({
  type: "match.end",
  t: t(clock++),
  matchId: MATCH_ID,
  reason: "checkmate",
  winnerId: "white",
});

const out = `${lines.join("\n")}\n`;
mkdirSync("logs", { recursive: true });
writeFileSync(`logs/${MATCH_ID}.jsonl`, out);
mkdirSync("packages/web/public/samples", { recursive: true });
writeFileSync(`packages/web/public/samples/${MATCH_ID}.jsonl`, out);
console.log(`Wrote ${lines.length} entries → logs/${MATCH_ID}.jsonl + public/samples/`);
