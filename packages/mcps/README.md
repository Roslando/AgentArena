# MCPs

Each subfolder here is a **standalone MCP server** — a self-contained *capsule* that implements
one task for agents to tackle. Capsules are completely decoupled from the orchestrator: the engine
talks to them only over the **Model Context Protocol** (stdio), so a capsule can be written
in any language as long as it speaks MCP. Drop a new one in, point a config at it — no engine change.

```
packages/mcps/
└── chess/        @agentarena/game-chess — reference implementation
```

## The contract an MCP server must fulfil

An AgentArena task server exposes, over MCP:

1. **A state tool** — returns the current game state for the player to act on
   (chess uses `get_board`). Its name is declared per-match via `stateToolName`.
2. **One or more action tools** — how the agent plays (chess uses `make_move`).
   The action result is a JSON object that signals the outcome:
   - `accepted: true` — the action was valid and the turn is complete. **This is the
     contract** the engine keys on (a `san` + `piece_moved` pair is accepted as a
     backward-compat fallback for chess).
   - `accepted: false` — the action was rejected (illegal move, malformed call). The
     engine re-prompts the same player and counts it as an **invalid action** — the
     generic, task-agnostic error signal (`message`/`reason` is shown back to the model).
   - *(Optional)* `summary: string` — a short label of the accepted action (e.g. the
     chess SAN), carried into the player's next-turn memory. Defaults to `san`, else the
     tool name.
   - `gameOver: true` (or `game_over`) when the task ends, plus `winnerId` (or
     `winner_id`). **Winner is optional** — a task with no winner still produces a full
     per-model stats report, and AgentArena recommends the best-fit model by composite score.
3. *(Optional)* **A prompt** via the MCP `prompts` capability — a task-specific system
   prompt the engine will use unless the match config overrides it.
4. *(Optional)* **Final stats** — a `stats` object on the **root** of the `game_over` result
   (next to `gameOver`/`winnerId`). The engine relays it **verbatim** into the match report
   (`match.summary.taskStats`), never interpreting it. Surface whatever your task measures —
   material and captures for chess, tests passed for a bash task, sources cited for research.
   This is how AgentArena reports the task's own metrics alongside the generic agentic ones.

The engine discovers tools, the prompt, and final stats **at connection/finish time** — nothing
is hardcoded, and it phrases its re-prompts from the MCP's actual tool names (no `make_move`
assumption). The engine **never declares a winner of its own**: it relays the task's outcome and
stats, and ranks the models by their agentic capability.

Every match logs a clean, per-model **statistics record** in the JSONL `match.summary`: turns,
tool calls, invalid actions (error rate), tokens, reflection latency, and (with prices) cost —
the agentic signals that tell you which model fits your task.

## Add your own MCP

1. Create `packages/mcps/<your-task>/` with its own `package.json`
   (name it `@agentarena/<your-task>`) and an MCP server in `src/index.ts`.
   The root workspace glob `packages/mcps/*` picks it up automatically.
2. Implement the contract above.
3. Point a match config at it:
   ```json
   "mcpServer": {
     "transport": "stdio",
     "command": "bun",
     "args": ["packages/mcps/<your-task>/dist/index.js"]
   },
   "stateToolName": "<your state tool>",
   "orchestrationMode": "turn-by-turn"
   ```
   `orchestrationMode` is `turn-by-turn` (default, agents alternate on a shared task),
   `concurrent` (act in parallel each round), or `independent` (each agent runs the whole task
   alone on its own MCP instance — the pure capability benchmark).
4. Run it: `bun packages/cli/src/index.ts your-match.json`.

No change to the engine, CLI, or types is required. See `chess/` for a full example.
