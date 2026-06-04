import { Chessboard } from "react-chessboard";
import type { MatchState } from "../state/types";

const PIECE_GLYPH: Record<string, string> = {
  pawn: "♟",
  knight: "♞",
  bishop: "♝",
  rook: "♜",
  queen: "♛",
  king: "♚",
};

const HIGHLIGHT = { background: "rgba(56, 189, 248, 0.35)" } as const;

/** Center stage: the animated board plus captured-piece trays. */
export function BoardView({ state }: { state: MatchState }) {
  const squareStyles: Record<string, React.CSSProperties> = {};
  if (state.lastMove) {
    squareStyles[state.lastMove.from] = HIGHLIGHT;
    squareStyles[state.lastMove.to] = HIGHLIGHT;
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <CapturedTray pieces={state.capturedByBlack} label="Black captured" />

      <div className="w-[min(88vw,52vh,500px)] overflow-hidden rounded-xl shadow-2xl ring-1 ring-slate-700/60">
        <Chessboard
          options={{
            position: state.fen,
            boardOrientation: "white",
            allowDragging: false,
            showNotation: true,
            animationDurationInMs: 300,
            squareStyles,
            darkSquareStyle: { backgroundColor: "#46577a" },
            lightSquareStyle: { backgroundColor: "#aab6d3" },
          }}
        />
      </div>

      <CapturedTray pieces={state.capturedByWhite} label="White captured" />
    </div>
  );
}

function CapturedTray({ pieces, label }: { pieces: string[]; label: string }) {
  return (
    <div className="flex h-7 items-center gap-0.5 text-xl text-slate-300" aria-label={label}>
      {pieces.map((p, i) => (
        <span key={`${p}-${i}`}>{PIECE_GLYPH[p] ?? "?"}</span>
      ))}
    </div>
  );
}
