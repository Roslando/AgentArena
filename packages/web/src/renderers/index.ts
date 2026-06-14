import type { ComponentType } from "react";
import { ChessRenderer } from "../chess/Renderer";
import type { MatchState } from "../chess/state/types";

/** Props every game renderer receives from the shell. */
export interface RendererProps {
  state: MatchState;
}

export type GameRenderer = ComponentType<RendererProps>;

/**
 * Registry: game slug → renderer component.
 *
 * To add a front-end for a new MCP task:
 *   1. Create `src/<your-task>/Renderer.tsx` that accepts `{ state: MatchState }`.
 *   2. Add one line here: `"<your-task>": YourRenderer`
 *
 * If a task has no entry here, the shell renders nothing in the center column.
 * The match still runs and the JSONL log is the source of truth.
 */
const REGISTRY: Record<string, GameRenderer> = {
  chess: ChessRenderer,
};

export function getRenderer(game: string | null): GameRenderer | null {
  if (!game) return null;
  return REGISTRY[game] ?? null;
}
