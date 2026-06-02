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
        reasoning: "",
        turns: 0,
        tokensInput: 0,
        tokensOutput: 0,
        totalLlmLatencyMs: 0,
        avgLlmLatencyMs: 0,
        faults: 0,
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
        return {
          ...p,
          thinking: false,
          reasoning: entry.content,
          turns,
          tokensInput: p.tokensInput + entry.tokensInput,
          tokensOutput: p.tokensOutput + entry.tokensOutput,
          totalLlmLatencyMs,
          avgLlmLatencyMs: turns > 0 ? Math.round(totalLlmLatencyMs / turns) : 0,
        };
      });

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

  // Board snapshot — authoritative position, faults and captures
  if (typeof json.fen === "string") {
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

  // Move outcome — append to the SAN timeline
  if (json.accepted === true && typeof json.san === "string") {
    const color: Color = state.moves.length % 2 === 0 ? "white" : "black";
    return {
      ...state,
      moves: [...state.moves, { ply: state.moves.length + 1, san: json.san, color }],
      lastMove:
        typeof json.from === "string" && typeof json.to === "string"
          ? { from: json.from, to: json.to }
          : state.lastMove,
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
export function foldEntries(
  initial: MatchState,
  entries: LogEntry[],
  upTo: number,
): MatchState {
  let state = initial;
  for (let i = 0; i < upTo && i < entries.length; i++) {
    const e = entries[i];
    if (e) state = matchReducer(state, e);
  }
  return state;
}
