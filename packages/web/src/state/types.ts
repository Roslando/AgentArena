export type Color = "white" | "black";

/** One LLM utterance, rendered as a chat bubble. */
export interface ChatMessage {
  turn: number;
  text: string;
}

export interface PlayerView {
  id: string;
  name: string;
  providerType: string;
  model: string;
  color: Color;
  /** true between llm.sent and llm.response */
  thinking: boolean;
  /** chat thread of reasoning texts, oldest first */
  messages: ChatMessage[];
  // running stats
  turns: number;
  tokensInput: number;
  tokensOutput: number;
  totalLlmLatencyMs: number;
  avgLlmLatencyMs: number;
  faults: number;
  /** USD price per 1M input tokens, when configured (for live cost display). */
  priceInputPerM?: number;
  /** USD price per 1M output tokens, when configured (for live cost display). */
  priceOutputPerM?: number;
}

export interface MoveRecord {
  ply: number;
  san: string;
  color: Color;
}

export interface MatchState {
  matchId: string | null;
  game: string | null;
  status: "idle" | "live" | "over";
  /** current board position */
  fen: string;
  /** last move squares for highlighting, e.g. { from: "e2", to: "e4" } */
  lastMove: { from: string; to: string } | null;
  moves: MoveRecord[];
  players: PlayerView[];
  capturedByWhite: string[];
  capturedByBlack: string[];
  winnerId: string | null;
  endReason: string | null;
  check: boolean;
}

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function initialMatchState(): MatchState {
  return {
    matchId: null,
    game: null,
    status: "idle",
    fen: START_FEN,
    lastMove: null,
    moves: [],
    players: [],
    capturedByWhite: [],
    capturedByBlack: [],
    winnerId: null,
    endReason: null,
    check: false,
  };
}
