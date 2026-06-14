---
name: agentarena-add-mcp
description: >-
  Build or add a new MCP task server ("arena") to the AgentArena benchmark, with or
  without a dashboard front-end. Use this whenever the user wants to plug a new task,
  game, or MCP into AgentArena — phrasings like "add an MCP to AgentArena", "create a
  new arena/task/game", "benchmark my own MCP", "make a custom AgentArena task", "add a
  front-end/renderer for my arena", or "wire my MCP server into the harness". Trigger
  even if they don't say the word "skill" or name the exact files. This skill encodes
  the exact tool-result contract the engine keys on and the real build/run pitfalls
  contributors hit, so the task plugs in cleanly the first time and the match runs end
  to end without forfeits caused by wiring mistakes.
---

# Add an MCP task to AgentArena

AgentArena is a harness that drops two LLMs into a task they can only navigate through
**MCP tools**, then scores how they *act* (read state, plan, follow rules). A "task" is a
standalone **MCP server** — a capsule. The engine is fully task-agnostic: it discovers your
tools, prompt, and final stats at runtime and never imports your code. Adding a task means
writing one MCP server, wiring a config, and (optionally) a dashboard renderer.

Your job when this skill triggers: produce a **working** task that plugs in on the first
run. The single biggest source of failure here is not the contract itself but the
**build/run mechanics** of this Bun monorepo — read `references/pitfalls.md` before you
declare done; those are real mistakes this project hit, captured so the user never repeats
them.

## The mental model

```
packages/
  engine/   ← the harness (NEVER edit it to add a task — it's already generic)
  mcps/     ← drop your capsule here
    chess/      reference implementation
    <your-task>/   ← what you create
  web/      ← optional dashboard; one renderer per task, picked by the `game` slug
```

A task is **decoupled** from the engine: they only ever talk over MCP (stdio). If you find
yourself editing `packages/engine`, stop — you're doing it wrong.

## Workflow

Do these in order. Each step has a concrete verification so you can loop without guessing.

### 1. Understand the contract (don't skip — it's subtle)

The engine keys on a precise tool-result shape, and it is split across two places:

- **Control signals** — `gameOver` (or `game_over`), `winnerId` (or `winner_id`), and a
  `stats` object — go at the **root** of the value your tool handler returns, *next to*
  `content`.
- **Action outcome** — `accepted: true|false`, plus `summary`/`message` — go **inside the
  JSON text** of `content[0].text`.

A result with neither `game_over` nor `accepted` is read as a **state read**, and the same
player keeps the floor. Full details, every field, and why it's shaped this way:
**read `references/mcp-contract.md` now.** Getting this wrong is the #1 cause of a task that
"connects but every move forfeits."

### 2. Scaffold the package

Copy the ready-made skeleton — it already encodes the contract correctly:

```bash
cp -r .claude/skills/agentarena-add-mcp/assets/mcp-template packages/mcps/<your-task>
```

Then in `packages/mcps/<your-task>/package.json` set the name to `@agentarena/<your-task>`.
Keep `"type": "module"`, `"main": "./dist/index.js"`. The `tsconfig.json` already extends
`../../../tsconfig.json` (three levels up — this is the correct depth under
`packages/mcps/<task>/`; a wrong depth is a classic break).

Register the workspace so Bun links it:

```bash
bun install
```

Verify: `packages/mcps/<your-task>/` exists with `package.json`, `tsconfig.json`,
`src/index.ts`, and `bun install` reports the new workspace with no error.

### 3. Implement your task in `src/index.ts`

Replace the example task in the template with yours. You must expose:

1. **A state tool** (default name `get_state`; pick any name and declare it in config via
   `stateToolName`). Returns the current state as JSON text. No `accepted`, no `game_over`.
2. **One or more action tools.** A valid action returns `{ accepted: true }` (optionally
   `summary`); an invalid one returns `{ accepted: false, message: "<why>" }` so the engine
   re-prompts the same player. When the task ends, set `gameOver: true` at the **root** of
   the returned object, plus optional `winnerId` and a `stats` object.
3. *(Optional but recommended)* **A system prompt** via the MCP `prompts` capability — the
   engine uses it unless the config overrides it per player.

Design principle (the project's philosophy — see the `eval-philosophy-no-crutches` memory):
the task should test the model's *own* capability. Don't expose a tool that hands the model
the answer (e.g. a `get_legal_moves` for chess) — make it derive state itself. The rate of
invalid actions is a headline metric, not a thing to engineer away.

Verify: `bun run --filter=@agentarena/<your-task> build` exits 0 and produces
`packages/mcps/<your-task>/dist/index.js`.

### 4. Wire a match config

Copy `agentarena.config.example.json` to a `<task>.json` (or `agentarena.config.json`) and set:

```json
{
  "matchId": "my-task-001",
  "game": "<your-task>",
  "players": [ /* two players, see the example */ ],
  "mcpServer": {
    "transport": "stdio",
    "command": "bun",
    "args": ["packages/mcps/<your-task>/dist/index.js"]
  },
  "stateToolName": "<your state tool name>",
  "orchestrationMode": "turn-by-turn"
}
```

- `game` is the renderer slug (step 6). Omit it if there's no front-end — the match still
  runs and the dashboard center stays empty.
- `stateToolName` **must** match your actual state tool's name, or preflight aborts.
- `orchestrationMode`: `turn-by-turn` (alternate on a shared task), `concurrent` (act in
  parallel each round), or `independent` (each model runs the whole task alone on its own
  MCP instance). The contract is identical in all three.

### 5. Build and run (this is where tasks break — be deliberate)

The `agentarena` CLI runs **compiled `dist/`, not your source.** After *any* edit to a
package's source you must rebuild its `dist`, and rebuild `@agentarena/types` first if you
touched it (other packages consume its `dist`). The root `bun run build` lists packages
explicitly and will **not** include your new MCP — build it by filter:

```bash
bun run --filter=@agentarena/types build      # only if you edited types
bun run --filter=@agentarena/<your-task> build
```

Smoke-test headless (no server, no browser, prints the agentic report):

```bash
bun run start --headless <task>.json
```

Verify: the match runs to a real task outcome (not an immediate forfeit), and the report
prints per-model stats. An instant forfeit almost always means a contract mistake in
step 3 (control signals in the wrong place) — re-check `references/mcp-contract.md`.

`references/pitfalls.md` lists every documented failure mode with its fix. Read it if
anything in this step misbehaves.

### 6. (Optional) Add a dashboard renderer

Only if the user wants a visual. The dashboard shell (header, chat thread, player panels,
report card, timeline, live/replay) is generic and already works for any task — you only
supply the **center view** for your task's state. **Read `references/frontend-renderer.md`**
for the exact two-file change (a `Renderer.tsx` + one line in the registry) and how the
`game` slug selects it. Without this, the match and the report still work; the center is
simply empty.

## When you're done

State plainly what you built, the exact build commands the user must run before launching
(`bun run --filter=...build`), and whether a renderer was added. If you skipped the
renderer, say the dashboard center will be empty by design and the JSONL log + CLI report
carry the full result.
