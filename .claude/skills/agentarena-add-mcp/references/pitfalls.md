# Pitfalls (real failures this project hit — don't repeat them)

Every item below was an actual mistake made while building AgentArena, captured so a new
contributor's agent skips the painful rediscovery. Scan this before declaring a task done.

## Build / run mechanics (the most common failures by far)

### Stale `dist` — "I changed the code but nothing changed"
The `agentarena` CLI and the live server run **compiled `dist/`**, not your TypeScript
source. Editing `src/` and re-running without rebuilding means the old code still runs. This
bit the project repeatedly (a `reasoning` parameter was wired in source but never rebuilt, so
it was silently never sent).
**Fix:** after any source edit, `bun run --filter=@agentarena/<pkg> build`. If you edited
`@agentarena/types`, build it **first** — `engine`, `web`, and others consume its `dist`,
not its source. Confirm with `grep` in the emitted `dist` if unsure.

### The root `build` script won't build your new MCP
Root `bun run build` lists packages explicitly (types → engine → game-chess → cli → web). A
brand-new MCP is **not** in that list, so `bun run build` silently skips it.
**Fix:** build your package by filter: `bun run --filter=@agentarena/<your-task> build`.
(Optionally add a line to the root `build` script if you want it included going forward.)

### Forgetting `bun install` after adding the package
A new folder under `packages/mcps/*` isn't linked into the workspace until you run
`bun install`. Skipping it breaks `--filter` and `workspace:*` resolution.
**Fix:** run `bun install` once after scaffolding.

### Wrong `tsconfig` extends depth
Under `packages/mcps/<task>/`, the package `tsconfig.json` must extend
`../../../tsconfig.json` (three levels up to the repo root). The template already has the
right depth; if you hand-write it, getting this wrong makes `tsc` use the wrong base config.

### A stale env var silently overrides `.env`
Under Bun, a shell/OS environment variable (e.g. a leftover `OPENAI_API_KEY` in your
Windows User scope) **overrides** the project `.env`. The project once forfeited a whole
match on a `402` because a stale key in the User scope shadowed the funded key in `.env`.
**Fix:** if auth fails unexpectedly, check for a conflicting env var in your shell/OS, not
just `.env`. Remember env changes only affect **new** processes — open a fresh terminal.

## Contract mistakes (cause "connects but every move forfeits")

### Control signals in the wrong place
`game_over` / `winnerId` / `stats` go at the **root** of the returned object; `accepted` /
`summary` / `message` go **inside `content[0].text`**. Swapping these is the #1 contract
bug. See `mcp-contract.md`.

### `stateToolName` mismatch
If the config's `stateToolName` doesn't match a tool your server actually exposes, preflight
aborts before a token is spent. Make them match (chess uses `get_board`, the default is
`get_state`).

### Empty assistant message on tool-only steps is normal
When a model calls a tool without prose, the visible `content` is empty — standard
function-calling behavior, not a bug and not the model's fault. If you want non-empty chat
bubbles / memory, ask for "one short sentence stating your action and plan" in your system
prompt (the reference `CHESS_SYSTEM_PROMPT` does exactly this). Don't treat the empty
content as an error.

### Truncation is a budget signal, not an invalid action
A response cut off at `maxTokens` (`finish_reason: length`) came back without a tool call
because it ran out of budget mid-emit — the model wasn't wrong, it was capped. The engine
already separates this (`truncations`, "raise maxTokens") from real errors. If your task's
models forfeit with truncations, raise `maxTokens`/`maxTokensPerTurn`, don't blame the model.

## Design / philosophy

### Don't add crutches
Don't expose a tool that hands the model the answer (the canonical example: a
`get_legal_moves` for chess). The harness measures the model's own state-tracking; the
invalid-action rate is a *headline metric*, not a defect to engineer away. Make the model
derive state from your state tool.

### The harness never declares a winner
Outcome, score, and any task scoreboard come **from your MCP** (root `winnerId` + `stats`),
relayed verbatim. Don't expect the engine to compute a result — it measures agentic
capability and *recommends* a best-fit model; it never referees.

### Don't time out a legitimately slow tool
The engine intentionally does **not** put a timeout on `callTool` — a slow MCP is normal and
not the model's fault; its latency is measured separately (`mcpLatencyMs`) and never charged
to the model. Don't add artificial tool timeouts to "be safe."

## Front-end (only if you add a renderer)

### Web also runs from `dist` for `agentarena`, and dev server needs a refresh
When launched via `agentarena`/the static server, the dashboard serves `web/dist` — rebuild
web (`bun run --filter=@agentarena/web build`) after renderer changes. In the Vite dev
server (`bun run --filter=@agentarena/web dev`), HMR usually reloads, but a **hard refresh**
clears stale state; in live mode, reconnecting replays the history buffer through the new code.

### Distinguish a state snapshot from an action result in your renderer
If your state JSON and your action-result JSON share fields, your renderer's reducer can
match the wrong branch. Chess hit exactly this: the move result also carried `fen`, so it
matched the board-snapshot branch first. The fix was a discriminator field present only in
the state read (`you_are`). If you parse tool results in a renderer, key each branch on a
field unique to that result type.
