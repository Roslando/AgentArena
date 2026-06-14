# Adding a dashboard renderer (optional)

The dashboard (`packages/web`) is a **generic broadcast shell** plus a per-task **renderer**.
The shell — header/scoreboard, chat thread, player panels, end-of-match report card,
timeline, and the live/replay plumbing — works for *any* task already. You only provide the
**center view** that visualizes your task's state. If you add nothing, the match and the
report still work; the center column is simply empty.

## How selection works

The match config's `game` slug is written into the log (`match.start.game`), folded into
`state.game` by the reducer, and `App.tsx` looks it up in a registry:

```tsx
// packages/web/src/chess/App.tsx
const GameRenderer = getRenderer(state.game);
...
{GameRenderer && <GameRenderer state={state} />}
```

`getRenderer` (in `packages/web/src/renderers/index.ts`) maps a slug to a component and
returns `null` for anything unregistered — that's the graceful empty-center fallback.

## The two-file change

### 1. Write your renderer

Create `packages/web/src/<your-task>/Renderer.tsx`. It receives the full match state and
renders whatever you want (an SVG, a table, a log view…):

```tsx
import type { MatchState } from "../chess/state/types";

export function YourTaskRenderer({ state }: { state: MatchState }) {
  // Derive your view from the folded state. The reducer already tracks players,
  // messages, tokens, status, winnerId, etc. If your task needs custom fields,
  // read them from the tool results you fold (see note below).
  return <div>/* your visualization of `state` */</div>;
}
```

`MatchState` lives in `packages/web/src/chess/state/types.ts`. The generic fields
(`players`, `status`, `winnerId`, `matchId`, `game`) are task-agnostic. The chess-specific
fields (`fen`, `capturedByWhite`, …) are there because chess is the reference task; ignore
them for your task, or add your own fields if you extend the reducer.

### 2. Register it (one line)

```ts
// packages/web/src/renderers/index.ts
import { YourTaskRenderer } from "../<your-task>/Renderer";

const REGISTRY: Record<string, GameRenderer> = {
  chess: ChessRenderer,
  "<your-task>": YourTaskRenderer,   // ← add this
};
```

The slug here must match the `game` value in your match config.

## If your task needs custom state in the renderer

The reducer (`packages/web/src/chess/state/matchReducer.ts`) folds the immutable log into
`MatchState`. It already accumulates players, chat messages, tokens, latency, tool calls,
and status — generic across tasks. If your renderer needs task-specific state (positions,
scores, a grid…), extend the reducer's `tool.result` handling to parse *your* state tool's
JSON into new `MatchState` fields. Keep two rules in mind:

- **One reducer drives both live and replay** — never branch on mode, or the two diverge.
- **Discriminate your result branches** by a field unique to each result type (see the
  `pitfalls.md` note about the chess `fen`/`you_are` collision), so a state snapshot and an
  action result never match the wrong branch.

## Verify

```bash
bunx tsc --noEmit --project packages/web/tsconfig.json   # types clean
bun run --filter=@agentarena/web build                   # production build (served by `agentarena`)
```

For interactive checking, run the dev server (`bun run --filter=@agentarena/web dev`) and a
log through it; remember a **hard refresh** if you changed the renderer and see stale output.
