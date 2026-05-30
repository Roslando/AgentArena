import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ChessGame } from "./chess-game.js";

const game = new ChessGame();

const server = new Server(
  { name: "agentarena-game-chess", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_board",
      description:
        "Returns the current chess board as an ASCII diagram with FEN, turn, captured pieces, fault counts, time remaining, and game status (check/checkmate/stalemate). Call this at the start of each turn.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "make_move",
      description:
        "Execute a chess move in UCI format (e.g., e2e4, e7e8q for promotion, e1g1 for castling). Illegal moves increment your fault counter; 3 faults = forfeit.",
      inputSchema: {
        type: "object",
        properties: {
          move: {
            type: "string",
            description: "UCI notation (e.g., e2e4, e7e8q, e1g1, e1c1)",
          },
        },
        required: ["move"],
      },
    },
  ],
}));

function getPlayerColor(): "white" | "black" {
  return game.getBoardState().playerColor;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "get_board") {
    const state = game.getBoardState();
    const yourColor = state.playerColor;
    const opponentColor = yourColor === "white" ? "black" : "white";

    const boardOutput: Record<string, unknown> = {
      fen: state.fen,
      ascii: state.ascii,
      you_are: yourColor,
      turn: state.turn,
      last_move_san: state.lastMove?.san ?? null,
      last_move_uci: state.lastMove?.uci ?? null,
      captured_by_you: state.capturedPieces[yourColor] ?? [],
      captured_by_opponent: state.capturedPieces[opponentColor] ?? [],
      check: state.inCheck,
      checkmate: state.inCheckmate,
      stalemate: state.inStalemate,
      your_faults: state.faults[yourColor],
      opponent_faults: state.faults[opponentColor],
    };

    const result: Record<string, unknown> = {
      content: [{ type: "text" as const, text: JSON.stringify(boardOutput, null, 2) }],
    };

    if (state.gameOver) {
      result.gameOver = true;
      result.winnerId = state.winner;
    }

    return result;
  }

  if (name === "make_move") {
    const move = (args as { move?: string }).move;

    if (!move || typeof move !== "string") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              accepted: false,
              message: "Missing required parameter: move (UCI string)",
            }),
          },
        ],
        isError: true,
      };
    }

    const result = game.makeMove(move);

    if (!result.success) {
      const output: Record<string, unknown> = {
        accepted: false,
        san: null,
        piece_moved: null,
        from: null,
        to: null,
        captured: null,
        promotion: null,
        is_check: false,
        is_checkmate: false,
        is_stalemate: false,
        fault: true,
        faults_total: result.faultCount ?? 0,
        forfeit: result.gameOver,
        game_over: result.gameOver,
        result: result.gameOver ? (result.winner ? `${result.winner} wins` : "draw") : null,
        message: result.error ?? "Illegal move",
      };

      const response: Record<string, unknown> = {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        isError: true,
      };

      if (result.gameOver) {
        response.gameOver = true;
        response.winnerId = result.winner;
      }

      return response;
    }

    const yourColor = getPlayerColor() === "white" ? "black" : "white"; // after move, turn has flipped
    const state = game.getBoardState();
    const output: Record<string, unknown> = {
      accepted: true,
      san: result.san,
      piece_moved: result.piece,
      from: result.from,
      to: result.to,
      captured: result.captured ?? null,
      promotion: result.promotion ?? null,
      is_check: state.inCheck,
      is_checkmate: state.inCheckmate,
      is_stalemate: state.inStalemate,
      fault: false,
      faults_total: state.faults[yourColor],
      forfeit: false,
      game_over: result.gameOver,
      result: result.gameOver
        ? result.winner
          ? `${result.winner} wins`
          : "draw"
        : null,
      message: `Move played: ${result.san}`,
    };

    const response: Record<string, unknown> = {
      content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
    };

    if (result.gameOver) {
      response.gameOver = true;
      response.winnerId = result.winner;
    }

    return response;
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);