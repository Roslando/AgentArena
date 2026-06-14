import type { LogEntry } from "@agentarena/types";
import { type Color, type MatchState, type PlayerView, START_FEN } from "./types";

/**
 * Pure fold of the immutable match log into renderable UI state.
 *
 * The same reducer drives both live (WebSocket) and replay (file) modes, so the
 * UI is guaranteed identical. Always returns a new state object (never mutates).
 */
export function matchReducer(prev: MatchState, entry: LogEntry): MatchState {
  switch (entry.type) {
    case "match.start": {
      const players: PlayerView[] = entry.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        providerType: p.providerType,
        model: p.model,
        color: i === 0 ? "white" : "black",
        thinking: false,
        messages: [],
        turns: 0,
        tokensInput: 0,
        tokensOutput: 0,
        totalLlmLatencyMs: 0,
        avgLlmLatencyMs: 0,
        faults: 0,
        toolCalls: 0,
        truncations: 0,
        ...(p.priceInputPerM !== undefined ? { priceInputPerM: p.priceInputPerM } : {}),
        ...(p.priceOutputPerM !== undefined ? { priceOutputPerM: p.priceOutputPerM } : {}),
      }));
      return {
        ...prev,
        matchId: entry.matchId,
        game: entry.game ?? null,
        status: "live",
        fen: START_FEN,
        lastMove: null,
        moves: [],
        players,
        capturedByWhite: [],
        capturedByBlack: [],
        winnerId: null,
        endReason: null,
        check: false,
      };
    }

    case "llm.sent":
      return mapPlayer(prev, entry.playerId, (p) => ({ ...p, thinking: true }));

    case "llm.response":
      return mapPlayer(prev, entry.playerId, (p) => {
        const turns = p.turns + 1;
        const totalLlmLatencyMs = p.totalLlmLatencyMs + (entry.latencyMs ?? 0);
        // Bubble label = the move this utterance belongs to (moves this colour has
        // already made + the one in progress), NOT the raw response count. A turn
        // can span several LLM calls — a read-only get_board, an illegal-move retry —
        // which must all share one number, else a player that inspects the board
        // before moving appears whole turns "ahead" of its opponent.
        const moveTurn = prev.moves.filter((m) => m.color === p.color).length + 1;
        // A tool-only response (e.g. a get_board read) usually carries empty content —
        // standard function-calling behaviour, not a bug. Skip the empty chat bubble;
        // the board still updates from the tool result, and the stats below still
        // accumulate (the read is a real LLM call that spent tokens and time).
        const messages = entry.content.trim()
          ? [...p.messages, { turn: moveTurn, text: entry.content }]
          : p.messages;
        return {
          ...p,
          thinking: false,
          messages,
          turns,
          tokensInput: p.tokensInput + entry.tokensInput,
          tokensOutput: p.tokensOutput + entry.tokensOutput,
          totalLlmLatencyMs,
          avgLlmLatencyMs: turns > 0 ? Math.round(totalLlmLatencyMs / turns) : 0,
        };
      });

    case "tool.call":
      // Count every tool call (state reads + actions) for the agentic protocol
      // signal: ideal is ~2 per move (observe then act). Accumulated live; replay
      // folds the same entries, so the count is identical in both modes.
      return mapPlayer(prev, entry.playerId, (p) => ({ ...p, toolCalls: p.toolCalls + 1 }));

    case "tool.result":
      return applyToolResult(prev, entry.result);

    case "match.summary": {
      // Prefer authoritative aggregated stats at end of match
      const byId = new Map(entry.players.map((p) => [p.playerId, p]));
      return {
        ...prev,
        players: prev.players.map((p) => {
          const s = byId.get(p.id);
          return s
            ? {
                ...p,
                turns: s.turns,
                tokensInput: s.totalTokensInput,
                tokensOutput: s.totalTokensOutput,
                totalLlmLatencyMs: s.totalLlmLatencyMs,
                avgLlmLatencyMs: s.avgLlmLatencyMs,
                toolCalls: s.toolCalls,
                // The engine's authoritative invalid-action count (chess: illegal moves).
                faults: s.invalidActions,
                // Responses cut off at the token budget (a budget signal, not an error).
                truncations: s.truncations ?? 0,
              }
            : p;
        }),
      };
    }

    case "match.end":
      return {
        ...prev,
        status: "over",
        winnerId: entry.winnerId ?? null,
        endReason: entry.reason,
        players: prev.players.map((p) => ({ ...p, thinking: false })),
      };

    case "game.over":
      return { ...prev, status: "over" };

    default:
      return prev;
  }
}

/** Replace one player (by id) via an updater, returning a new state. */
function mapPlayer(
  state: MatchState,
  playerId: string | undefined,
  fn: (p: PlayerView) => PlayerView,
): MatchState {
  if (!playerId) return state;
  return {
    ...state,
    players: state.players.map((p) => (p.id === playerId ? fn(p) : p)),
  };
}

/**
 * A tool result is the MCP callTool payload: { content: [{ type: "text", text }] }.
 * The text is JSON — either a board snapshot (get_board) or a move outcome (make_move).
 */
function applyToolResult(state: MatchState, result: unknown): MatchState {
  const json = parseToolJson(result);
  if (!json) return state;

  // Board snapshot (get_board) — authoritative position, faults and captures. Keyed on
  // you_are, which only get_board emits: a make_move result now also carries `fen`, so
  // `fen` alone no longer tells a snapshot apart from a move outcome.
  if (typeof json.fen === "string" && typeof json.you_are === "string") {
    const youAre = json.you_are === "black" ? "black" : "white";
    const opponent: Color = youAre === "white" ? "black" : "white";
    const yourFaults = Number(json.your_faults ?? 0);
    const oppFaults = Number(json.opponent_faults ?? 0);

    const players = state.players.map((p) => {
      if (p.color === youAre) return { ...p, faults: yourFaults };
      if (p.color === opponent) return { ...p, faults: oppFaults };
      return p;
    });

    const capturedYou = toStringArray(json.captured_by_you);
    const capturedOpp = toStringArray(json.captured_by_opponent);

    return {
      ...state,
      fen: json.fen,
      check: Boolean(json.check),
      lastMove: uciToSquares(json.last_move_uci),
      players,
      capturedByWhite: youAre === "white" ? capturedYou : capturedOpp,
      capturedByBlack: youAre === "black" ? capturedYou : capturedOpp,
    };
  }

  // Illegal move — the mover earns a fault. The result carries the mover's running fault
  // count (faults_total); attribute it to the side to move (parity), since an illegal
  // move does NOT advance the SAN list, so parity still points at the mover. get_board
  // snapshots lag and never capture the *forfeiting* 3rd fault (no turn follows it), so
  // this branch is what keeps the displayed count in sync with the log.
  if (json.fault === true && typeof json.faults_total === "number") {
    const color: Color = state.moves.length % 2 === 0 ? "white" : "black";
    const players = state.players.map((p) =>
      p.color === color ? { ...p, faults: json.faults_total as number } : p,
    );
    return { ...state, players };
  }

  // Move outcome — append to the SAN timeline and apply the post-move position
  if (json.accepted === true && typeof json.san === "string") {
    const color: Color = state.moves.length % 2 === 0 ? "white" : "black";
    // A capture on this move adds the taken piece to the MOVER's tray. A later get_board
    // snapshot REPLACES the tray with the authoritative list, so appending here can't
    // double-count — it only matters for the final move (and any blind stretch), which
    // no get_board ever follows.
    const captured = typeof json.captured === "string" ? json.captured : null;
    return {
      ...state,
      // The move result carries the post-move FEN, so the board reflects the move at
      // once — including the game-ending move that no get_board snapshot follows.
      fen: typeof json.fen === "string" ? json.fen : state.fen,
      moves: [...state.moves, { ply: state.moves.length + 1, san: json.san, color }],
      lastMove:
        typeof json.from === "string" && typeof json.to === "string"
          ? { from: json.from, to: json.to }
          : state.lastMove,
      capturedByWhite:
        captured && color === "white"
          ? [...state.capturedByWhite, captured]
          : state.capturedByWhite,
      capturedByBlack:
        captured && color === "black"
          ? [...state.capturedByBlack, captured]
          : state.capturedByBlack,
    };
  }

  return state;
}

function parseToolJson(result: unknown): Record<string, unknown> | null {
  const obj = result as { content?: unknown } | null;
  if (obj && Array.isArray(obj.content)) {
    for (const item of obj.content) {
      const i = item as { type?: string; text?: string };
      if (i?.type === "text" && typeof i.text === "string") {
        try {
          const parsed = JSON.parse(i.text);
          if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/** "e2e4" or "e7e8q" → { from: "e2", to: "e4" } */
function uciToSquares(uci: unknown): { from: string; to: string } | null {
  if (typeof uci !== "string" || uci.length < 4) return null;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4) };
}

/** Fold an entire entry sequence from scratch — used for replay scrubbing. */
export function foldEntries(initial: MatchState, entries: LogEntry[], upTo: number): MatchState {
  let state = initial;
  for (let i = 0; i < upTo && i < entries.length; i++) {
    const e = entries[i];
    if (e) state = matchReducer(state, e);
  }
  return state;
}
