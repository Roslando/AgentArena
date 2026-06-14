/**
 * AgentArena MCP task template — a minimal but COMPLETE example.
 *
 * The example task is a "guess the secret number" duel: each turn a player reads the
 * range, then guesses; guessing the secret ends the task. It is deliberately a real
 * agentic test (the model must narrow the range across turns from the higher/lower hints
 * — no tool hands it the answer).
 *
 * Replace the task logic with your own, but KEEP the tool-result shapes — they are the
 * contract the engine keys on:
 *   - control signals (gameOver / winnerId / stats) live at the ROOT of the returned object
 *   - action outcome (accepted / summary / message) lives INSIDE content[0].text (JSON)
 *   - a result with NEITHER is treated as a state read (same player keeps the floor)
 *
 * Note the typing: any return that carries root-level control signals is built as a
 * `Record<string, unknown>` (like the reference chess server), because those extra root
 * fields are not part of the SDK's CallToolResult type. See references/mcp-contract.md.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ----- Task state (replace with your own) -----------------------------------------------
const SECRET = 1 + Math.floor(Math.random() * 100); // 1..100
let low = 1;
let high = 100;

// ----- System prompt the engine will fetch (optional but recommended) -------------------
const SYSTEM_PROMPT =
  "You are playing a number-guessing duel. Each turn, call get_state to see the current " +
  "range, then call guess with a single integer inside it. After each guess the range " +
  "narrows from the higher/lower feedback — track it and converge. Reply with one short " +
  "sentence stating your guess and reasoning, then call the tool; never send an empty message.";

const server = new Server(
  { name: "agentarena-REPLACE_ME", version: "0.1.0" },
  { capabilities: { tools: {}, prompts: {} } },
);

// ----- Tool list ------------------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      // STATE TOOL — declare this name in the config's `stateToolName`.
      name: "get_state",
      description:
        "Returns the current known range for the secret number: { low, high }. Call this " +
        "at the start of every turn before guessing.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      // ACTION TOOL
      name: "guess",
      description:
        "Guess the secret integer. Provide `value` as an integer within the current range. " +
        "Returns higher/lower feedback; an out-of-range or non-integer guess is rejected.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "number", description: "an integer in [low, high]" } },
        required: ["value"],
      },
    },
  ],
}));

// ----- Tool calls -----------------------------------------------------------------------
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // STATE READ — no `accepted`, no `game_over` ⇒ the engine feeds it back to the same player.
  if (name === "get_state") {
    return { content: [{ type: "text" as const, text: JSON.stringify({ low, high }) }] };
  }

  if (name === "guess") {
    const value = (args as { value?: unknown }).value;

    // INVALID ACTION — `accepted: false` in the text ⇒ same player is re-prompted with `message`.
    if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              accepted: false,
              message: `Invalid guess. Provide an integer within [${low}, ${high}].`,
            }),
          },
        ],
        isError: true,
      };
    }

    // WIN — the task ends. Control signals go at the ROOT, so build a Record (the extra
    // root fields are not part of the SDK's CallToolResult type).
    if (value === SECRET) {
      const response: Record<string, unknown> = {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ accepted: true, summary: `guessed ${value} — correct` }),
          },
        ],
        gameOver: true,
        // Optional task scoreboard, relayed verbatim into the report — never interpreted.
        stats: { secret: SECRET, finalRange: { low, high } },
      };
      // To attribute a winner, set `response.winnerId` to the acting player's id. A 2-player
      // task can use a positional token the engine maps to players[0]/players[1] (the chess
      // server returns "white"/"black"). This duel has no per-server identity for the mover,
      // so we omit winnerId and let the report rank models by composite score.
      return response;
    }

    // VALID-BUT-WRONG — accepted action, narrow the range, give feedback. Turn passes.
    const hint = value < SECRET ? "higher" : "lower";
    if (value < SECRET) low = Math.max(low, value + 1);
    else high = Math.min(high, value - 1);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            accepted: true,
            summary: `guessed ${value}`,
            feedback: hint, // the secret is higher/lower than your guess
            low,
            high,
          }),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ----- Prompt (optional) ----------------------------------------------------------------
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{ name: "play-prompt", description: "System prompt for this task (AgentArena)" }],
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  if (req.params.name !== "play-prompt") throw new Error(`Unknown prompt: ${req.params.name}`);
  return {
    description: "System prompt for this task (AgentArena)",
    messages: [{ role: "user" as const, content: { type: "text" as const, text: SYSTEM_PROMPT } }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
