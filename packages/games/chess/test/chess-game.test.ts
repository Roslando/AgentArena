import { describe, expect, it } from "vitest";
import { ChessGame } from "../src/chess-game.js";

describe("ChessGame", () => {
  describe("getBoardState — ASCII alignment", () => {
    it("returns a properly aligned ASCII board", () => {
      const game = new ChessGame();
      const state = game.getBoardState();

      const lines = state.ascii.split("\n");
      expect(lines[0]).toContain("+");
      expect(lines[0]).toContain("-");

      const contentLines = lines.filter((l) => l.includes("|"));
      const lengths = contentLines.map((l) => l.length);
      expect(lengths.every((len) => len === lengths[0])).toBe(true);
      expect(contentLines.length).toBe(8);
      expect(lines.length).toBeGreaterThanOrEqual(10);

      expect(lines[1]).toMatch(/8.*\|/);
      expect(lines[lines.length - 1]).toContain("a");
      expect(lines[lines.length - 1]).toContain("h");
    });

    it("includes FEN, turn, color, and game status", () => {
      const game = new ChessGame();
      const state = game.getBoardState();

      expect(state.fen).toBeTruthy();
      expect(state.turn).toBe("white");
      expect(state.playerColor).toBe("white");
      expect(state.inCheck).toBe(false);
      expect(state.inCheckmate).toBe(false);
      expect(state.inStalemate).toBe(false);
      expect(state.inDraw).toBe(false);
      expect(state.gameOver).toBe(false);
      expect(state.lastMove).toBeNull();
    });

    it("tracks fault counts at zero initially", () => {
      const game = new ChessGame();
      const state = game.getBoardState();
      expect(state.faults.white).toBe(0);
      expect(state.faults.black).toBe(0);
    });

    it("reports captured pieces as empty initially", () => {
      const game = new ChessGame();
      const state = game.getBoardState();
      expect(state.capturedPieces.white).toEqual([]);
      expect(state.capturedPieces.black).toEqual([]);
    });
  });

  describe("makeMove — legal moves", () => {
    it("accepts a legal UCI move and returns SAN and piece name", () => {
      const game = new ChessGame();
      const result = game.makeMove("e2e4");

      expect(result.success).toBe(true);
      expect(result.san).toBe("e4");
      expect(result.piece).toBe("pawn");
      expect(result.gameOver).toBe(false);
    });

    it("tracks last move after a successful move", () => {
      const game = new ChessGame();
      game.makeMove("e2e4");
      const state = game.getBoardState();
      expect(state.lastMove).toEqual({ san: "e4", uci: "e2e4" });
    });

    it("updates FEN after a move", () => {
      const game = new ChessGame();
      const before = game.getBoardState().fen;
      game.makeMove("e2e4");
      expect(game.getBoardState().fen).not.toBe(before);
    });

    it("detects a capture and reports captured piece", () => {
      const game = new ChessGame();
      game.makeMove("e2e4");
      game.makeMove("d7d5");
      const result = game.makeMove("e4d5");

      expect(result.success).toBe(true);
      expect(result.captured).toBe("pawn");
    });

    it("tracks captured pieces by opponent side", () => {
      const game = new ChessGame();
      game.makeMove("e2e4");
      game.makeMove("d7d5");
      game.makeMove("e4d5");

      const state = game.getBoardState();
      expect(state.capturedPieces.black).toContain("pawn");
    });
  });

  describe("makeMove — illegal moves and faults", () => {
    it("rejects an illegal UCI move and increments fault count", () => {
      const game = new ChessGame();
      const result = game.makeMove("e2e5");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Illegal move");
      expect(result.faultCount).toBe(1);
      expect(result.gameOver).toBe(false);
    });

    it("increments faults on repeated illegal moves by same side", () => {
      const game = new ChessGame();
      game.makeMove("e2e5"); // fault 1 (white)
      expect(game.getBoardState().faults.white).toBe(1);

      game.makeMove("e2d4"); // fault 2 (white — turn didn't change)
      expect(game.getBoardState().faults.white).toBe(2);
    });

    it("3 faults by the same player = forfeit immediately", () => {
      const game = new ChessGame();
      game.makeMove("e2e5"); // fault 1
      game.makeMove("e2d4"); // fault 2
      const result = game.makeMove("e2c3"); // fault 3

      expect(result.success).toBe(false);
      expect(result.faultCount).toBe(3);
      expect(result.gameOver).toBe(true);
      expect(result.winner).toBe("black");
    });

    it("does not count illegal moves for the non-faulting side", () => {
      const game = new ChessGame();
      game.makeMove("e2e4"); // legal white
      game.makeMove("d7d4"); // illegal black → fault 1
      game.makeMove("d7d4"); // illegal black → fault 2

      const state = game.getBoardState();
      expect(state.faults.white).toBe(0);
      expect(state.faults.black).toBe(2);
      expect(state.gameOver).toBe(false);
    });
  });

  describe("promotion", () => {
    it("promotes a pawn with UCI promotion notation", () => {
      // Black king on d8 so e8 is empty for promotion
      const game = new ChessGame("3k4/4P3/8/8/8/8/8/4K3 w - - 0 1");
      const result = game.makeMove("e7e8q");

      expect(result.success).toBe(true);
      expect(result.san).toBe("e8=Q+");
      expect(result.piece).toBe("pawn");
    });
  });

  describe("castling", () => {
    it("handles kingside castling (e1g1 returns O-O)", () => {
      const game = new ChessGame("4k3/8/8/8/8/8/8/4K2R w K - 0 1");
      const result = game.makeMove("e1g1");

      expect(result.success).toBe(true);
      expect(result.san).toBe("O-O");
    });

    it("handles queenside castling (e1c1 returns O-O-O)", () => {
      const game = new ChessGame("4k3/8/8/8/8/8/8/R3K3 w Q - 0 1");
      const result = game.makeMove("e1c1");

      expect(result.success).toBe(true);
      expect(result.san).toBe("O-O-O");
    });
  });

  describe("en passant", () => {
    it("captures en passant correctly", () => {
      const game = new ChessGame("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2");
      const result = game.makeMove("e5d6");

      expect(result.success).toBe(true);
      expect(result.san).toBe("exd6");
      expect(result.captured).toBe("pawn");
    });
  });

  describe("checkmate", () => {
    it("detects checkmate via playing moves (fool's mate)", () => {
      const game = new ChessGame();
      game.makeMove("f2f3");
      game.makeMove("e7e5");
      game.makeMove("g2g4");
      const result = game.makeMove("d8h4");

      expect(result.success).toBe(true);
      expect(result.inCheckmate).toBe(true);
      expect(result.gameOver).toBe(true);
      expect(result.winner).toBe("black");
    });
  });

  describe("stalemate", () => {
    it("detects stalemate with no winner", () => {
      // Black king on a1, White rook on b2, White king on c1
      // Black to move — no legal moves, not in check => stalemate
      const game = new ChessGame("8/8/8/8/8/8/1R6/k1K5 b - - 0 1");
      const state = game.getBoardState();

      expect(state.inStalemate).toBe(true);
      expect(state.inCheckmate).toBe(false);
      expect(state.inCheck).toBe(false);
    });
  });

  });