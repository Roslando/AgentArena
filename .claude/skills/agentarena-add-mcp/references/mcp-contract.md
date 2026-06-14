# The MCP task contract (exact)

This is the precise shape the engine keys on. It is mined from the engine's own parser
(`packages/engine/src/match-runner.ts`) and the reference server
(`packages/mcps/chess/src/index.ts`). When in doubt, read those two files — they are the
ground truth.

## The tool-result envelope

Every MCP tool handler returns a value shaped like this:

```ts
{
  content: [{ type: "text", text: "<JSON string>" }],
  // OPTIONAL control signals — at the ROOT, siblings of `content`:
  gameOver?: true,            // also accepted: game_over
  winnerId?: string,          // also accepted: winner_id  (omit for no/!draw winner)
  stats?: Record<string, unknown>,
  isError?: true,             // set on rejected/error results (optional, cosmetic to the engine)
}
```

The crucial, easy-to-miss split:

| Signal | Where the engine reads it | Notes |
| --- | --- | --- |
| `gameOver` / `game_over` | **root** of the returned object | truthy ends the match |
| `winnerId` / `winner_id` | **root** | optional — a task may have no winner |
| `stats` | **root** | relayed **verbatim** into the report, never interpreted |
| `accepted` | **inside `content[0].text`** (parsed JSON) | `true` completes the action, `false` is a rejection |
| `summary` | inside the text JSON | short label of the action, fed to the model's memory |
| `message` / `reason` | inside the text JSON | shown back to the model on a rejection |

If you put `game_over` *inside* the text JSON instead of at the root, the match never ends.
If you put `accepted` at the root instead of in the text, every action looks like a state
read and the turn never completes. These are the two classic mistakes.

## How the engine classifies each tool result

The parser checks, in this order:

1. **`root.game_over || root.gameOver` truthy** → the task is over. The engine reads
   `root.winner_id ?? root.winnerId` and `root.stats`, writes `game.over`, and ends the
   match. (This is checked *before* `accepted`, so the winning action can carry both
   `accepted: true` in its text and `gameOver: true` at the root — the root wins.)
2. **text `accepted === false`** → a rejected action. Counts as one **invalid action**
   (the headline error metric), increments the consecutive-error counter, and the **same
   player is re-prompted** with `message`/`reason`. (After `maxConsecutiveErrors` in a row
   with no success, the circuit breaker stops that agent — the default is 4.)
3. **text `accepted === true`** (or the chess fallback `san && piece_moved`) → the action
   is accepted, the unit of play is complete, and in `turn-by-turn` the next player acts.
   `summary` (or `san`, else the tool name) is stored as the action's label.
4. **neither** → a **state read**. The result is fed back to the *same* player, who keeps
   the floor (this is what lets a model call your state tool then act in the same turn). A
   successful read resets the consecutive-error counter.

## The three tools you expose

### 1. State tool (required)

Default name `get_state`; you may name it anything and declare it in the config's
`stateToolName`. It returns the current state and must NOT carry `accepted` or `game_over`:

```ts
// inside CallToolRequestSchema handler, when name === "get_state"
return { content: [{ type: "text", text: JSON.stringify(currentState) }] };
```

Put everything the model needs to act in this JSON. The engine does **not** hand the model
the state — the model must call this tool itself each turn (pure-pull). That's deliberate:
deriving and tracking state is the capability under test.

### 2. Action tool(s) (required)

```ts
// valid action
return { content: [{ type: "text", text: JSON.stringify({ accepted: true, summary: "took X" }) }] };

// invalid action (re-prompts the same player with `message`)
return {
  content: [{ type: "text", text: JSON.stringify({ accepted: false, message: "X is not allowed because…" }) }],
  isError: true,
};

// the action that ends the task — note game_over/winnerId/stats at the ROOT:
return {
  content: [{ type: "text", text: JSON.stringify({ accepted: true, summary: "final move" }) }],
  gameOver: true,
  winnerId: "player-1",            // omit, or null-normalized, for a draw/no-winner
  stats: { score: 42, foo: "bar" } // optional, relayed verbatim into the report
};
```

`stats` is your task's own scoreboard (chess sends material & captures; a bash task could
send tests-passed; a research task, sources-cited). The harness shows it next to the generic
agentic metrics and **never** interprets it. AgentArena never declares a winner of its own —
the outcome is always yours.

### 3. System prompt (optional, recommended)

Expose the MCP `prompts` capability so the engine can fetch a task-specific system prompt
(it calls `listPrompts()` then `getPrompt()` and uses the first prompt's text). A player's
config `systemPrompt` overrides it. The reference server exposes a `play-prompt`; copy that
pattern. If you expose no prompt, the engine falls back to a generic agentic prompt.

## Orchestration modes (same contract, different driving)

- `turn-by-turn` (default): agents alternate on one shared MCP. One accepted action = one
  turn, then rotate. For interactive/adversarial tasks.
- `concurrent`: all agents act each round in parallel on one shared MCP; the first
  `game_over` ends it.
- `independent`: each agent runs the whole task **alone on its own MCP instance**, in
  parallel. There's no head-to-head winner; the report ranks models by composite score, and
  each episode's `stats` are attached per-player. Best for pure capability benchmarks.

Your server doesn't need to know the mode — the same tools and contract serve all three. In
`independent`, return a per-agent `game_over` (with `winner_id`/`winnerId`/`winner` truthy
when *that* agent solved it) so the report can mark solvers.
