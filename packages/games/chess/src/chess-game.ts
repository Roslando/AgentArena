import { Chess } from "chess.js";

/**
 * Convert a chess.js ASCII board to Unicode chess symbols.
 * chess.js .ascii() produces lines like:
 *   +------------------------+
 * 8 | r  n  b  q  k  b  n  r |
 * We map letters to Unicode and replace empty squares with ".".
 */
function asciiToUnicode(ascii: string): string {
  const PIECE_MAP: Record<string, string> = {
    K: "♔",
    Q: "♕",
    R: "♖",
    B: "♗",
    N: "♘",
    P: "♙",
    k: "♚",
    q: "♛",
    r: "♜",
    b: "♝",
    n: "♞",
    p: "♟",
  };

  const lines = ascii.split("\n");
  // chess.ascii() wraps content between two border lines.
  // Content lines have format: "8 | r  n  b  q  k  b  n  r |"
  // We replace letters inside |...| and leave borders/coordinates intact.
  return lines
    .map((line) => {
      // Only transform content lines (containing | and file letters or spaces between pipes)
      if (!line.includes("|")) return line;
      // Replace piece letters inside the board area
      let transformed = "";
      for (const ch of line) {
        transformed += PIECE_MAP[ch] ?? ch;
      }
      return transformed;
    })
    .join("\n");
}

/** BoardState.ascii contains Unicode chess symbols (♔♕♖♗♘♙ / ♚♛♜♝♞♟) with "." for empty squares */
export interface BoardState {
  ascii: string;
  fen: string;
  playerColor: "white" | "black";
  turn: "white" | "black";
  lastMove: { san: string; uci: string } | null;
  capturedPieces: Record<string, string[]>;
  faults: Record<string, number>;
  inCheck: boolean;
  inCheckmate: boolean;
  inStalemate: boolean;
  inDraw: boolean;
  gameOver: boolean;
  winner: string | null;
}

export interface MoveResult {
  success: boolean;
  san?: string;
  piece?: string;
  from?: string;
  to?: string;
  promotion?: string | null;
  captured?: string | undefined;
  inCheck?: boolean;
  inCheckmate?: boolean;
  inStalemate?: boolean;
  inDraw?: boolean;
  gameOver: boolean;
  winner: string | null;
  faultCount?: number;
  error?: string;
}

const PIECE_NAMES: Record<string, string> = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
};

export class ChessGame {
  private chess: Chess;
  private faults: Map<string, number>;
  private capturedPieces: Map<string, string[]>;
  private lastMove: { san: string; uci: string } | null = null;
  private gameOver = false;
  private winner: string | null = null;

  constructor(fen?: string) {
    try {
      this.chess = fen ? new Chess(fen) : new Chess();
    } catch {
      throw new Error(`Invalid FEN: ${fen}`);
    }
    this.faults = new Map([
      ["w", 0],
      ["b", 0],
    ]);
    this.capturedPieces = new Map([
      ["w", []],
      ["b", []],
    ]);
  }

  private colorName(c: "w" | "b"): "white" | "black" {
    return c === "w" ? "white" : "black";
  }

  getBoardState(): BoardState {
    const turn = this.chess.turn() as "w" | "b";
    const playerColor = this.colorName(turn);

    return {
      ascii: asciiToUnicode(this.chess.ascii()),
      fen: this.chess.fen(),
      playerColor,
      turn: playerColor,
      lastMove: this.lastMove,
      capturedPieces: {
        white: this.capturedPieces.get("w") ?? [],
        black: this.capturedPieces.get("b") ?? [],
      },
      faults: {
        white: this.faults.get("w") ?? 0,
        black: this.faults.get("b") ?? 0,
      },
      inCheck: this.chess.isCheck(),
      inCheckmate: this.chess.isCheckmate(),
      inStalemate: this.chess.isStalemate(),
      inDraw: this.chess.isDraw(),
      gameOver: this.gameOver,
      winner: this.winner,
    };
  }

  makeMove(uci: string): MoveResult {
    if (this.gameOver) {
      return {
        success: false,
        error: "Game is already over",
        gameOver: true,
        winner: this.winner,
      };
    }

    const turn = this.chess.turn() as "w" | "b";

    // Attempt the move (chess.js v1 throws on invalid moves)
    let move: ReturnType<Chess["move"]>;
    try {
      move = this.chess.move(uci);
    } catch {
      move = null as unknown as ReturnType<Chess["move"]>;
    }

    if (!move) {
      // Illegal move — increment fault
      const faultCount = (this.faults.get(turn) ?? 0) + 1;
      this.faults.set(turn, faultCount);

      if (faultCount >= 3) {
        this.gameOver = true;
        this.winner = this.colorName(turn === "w" ? "b" : "w");
      }

      return {
        success: false,
        error: `Illegal move: ${uci}`,
        faultCount,
        gameOver: this.gameOver,
        winner: this.winner,
      };
    }

    // Record last move
    const lastUci = `${move.from}${move.to}${move.promotion ?? ""}`;
    this.lastMove = { san: move.san, uci: lastUci };

    // Track captured pieces
    if (move.captured) {
      const opponent = turn === "w" ? "b" : "w";
      const captured = this.capturedPieces.get(opponent) ?? [];
      captured.push(PIECE_NAMES[move.captured] ?? move.captured);
      this.capturedPieces.set(opponent, captured);
    }

    // Check terminal conditions
    const inCheckmate = this.chess.isCheckmate();
    const inStalemate = this.chess.isStalemate();
    const inDraw = this.chess.isDraw();

    if (inCheckmate) {
      this.gameOver = true;
      this.winner = this.colorName(turn);
    } else if (inStalemate || inDraw) {
      this.gameOver = true;
      this.winner = null;
    }

    return {
      success: true,
      san: move.san,
      piece: PIECE_NAMES[move.piece] ?? move.piece,
      from: move.from,
      to: move.to,
      promotion: move.promotion ?? null,
      captured: move.captured ? (PIECE_NAMES[move.captured] ?? move.captured) : undefined,
      inCheck: this.chess.isCheck(),
      inCheckmate,
      inStalemate,
      inDraw,
      gameOver: this.gameOver,
      winner: this.winner,
    };
  }
}
