# Games

Each subfolder here is a **standalone MCP server** that implements one game (or task)
for agents to play. Games are completely decoupled from the orchestrator: the engine
talks to them only over the **Model Context Protocol** (stdio), so a game can be written
in any language as long as it speaks MCP.

```
packages/games/
└── chess/        @agentarena/game-chess — reference implementation
```

## The contract a game must fulfil

An AgentArena game server exposes, over MCP:

1. **A state tool** — returns the current game state for the player to act on
   (chess uses `get_board`). Its name is declared per-match via `stateToolName`.
2. **One or more action tools** — how the agent plays (chess uses `make_move`).
   The tool result should signal:
   - `gameOver: true` (or `game_over`) when the game ends, plus `winnerId` (or `winner_id`);
   - `accepted: false` when an action is illegal, so the engine can re-prompt.
3. *(Optional)* **A prompt** via the MCP `prompts` capability — a game-specific system
   prompt the engine will use unless the match config overrides it.

The engine discovers tools and the prompt **at connection time** — nothing is hardcoded.

## Add your own game

1. Create `packages/games/<your-game>/` with its own `package.json`
   (name it `@agentarena/game-<your-game>`) and an MCP server in `src/index.ts`.
   The root workspace glob `packages/games/*` picks it up automatically.
2. Implement the contract above.
3. Point a match config at it:
   ```json
   "mcpServer": {
     "transport": "stdio",
     "command": "bun",
     "args": ["packages/games/<your-game>/dist/index.js"]
   },
   "stateToolName": "<your state tool>"
   ```
4. Run it: `bun packages/cli/src/index.ts your-match.json`.

No change to the engine, CLI, or types is required. See `chess/` for a full example.
