import { BoardView } from "./components/BoardView";
import type { MatchState } from "./state/types";

export function ChessRenderer({ state }: { state: MatchState }) {
  return <BoardView state={state} />;
}
