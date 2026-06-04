import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ChessGame } from "./chess-game.js";

const game = new ChessGame();

const server = new Server(
  { name: "agentarena-game-chess", version: "0.1.0" },
  { capabilities: { tools: {}, prompts: {} } },
);

const CHESS_SYSTEM_PROMPT =
  "You are a professional chess player playing a match.\n" +
  "Analyze the current board state and decide your next move.\n" +
  "In one short sentence, state your move AND your short-term plan (your intention), " +
  "then call the move tool. This note is shown back to you next turn, so make it " +
  "useful to your future self.\n" +
  "No lists. No JSON. No long explanations.";

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_board",
      description:
        "Returns the current board state: a Unicode diagram, FEN, which color you play (you_are), whose turn it is, opponent's last move (last_move_san/last_move_uci), pieces captured by each side, fault counts, and game status (check/checkmate/stalemate). Called automatically by the arena at turn start — call it again only if you need a refreshed view.",
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

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "play-prompt",
      description: "System prompt for chess gameplay (AgentArena)",
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  if (req.params.name !== "play-prompt") {
    throw new Error(`Unknown prompt: ${req.params.name}`);
  }
  return {
    description: "System prompt for chess gameplay (AgentArena)",
    messages: [
      { role: "user" as const, content: { type: "text" as const, text: CHESS_SYSTEM_PROMPT } },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);