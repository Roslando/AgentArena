import { Chessboard } from "react-chessboard";
import type { MatchState } from "../state/types";

// Captured pieces are drawn in their own colour: each side's tray holds the OPPONENT's
// pieces it took (White's trophies are black pieces, Black's trophies are white ones).
const GLYPHS: Record<"white" | "black", Record<string, string>> = {
  white: { pawn: "♙", knight: "♘", bishop: "♗", rook: "♖", queen: "♕", king: "♔" },
  black: { pawn: "♟", knight: "♞", bishop: "♝", rook: "♜", queen: "♛", king: "♚" },
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
      {/* Each tray shows the pieces THAT side captured (its trophies). Per the MCP
          server convention, state.capturedByBlack holds the pieces Black captured
          (white pieces). The board is oriented White-at-bottom, so Black sits on top —
          its trophies belong in the top tray. */}
      <CapturedTray pieces={state.capturedByBlack} label="Black captured" color="white" />

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

      <CapturedTray pieces={state.capturedByWhite} label="White captured" color="black" />
    </div>
  );
}

function CapturedTray({
  pieces,
  label,
  color,
}: { pieces: string[]; label: string; color: "white" | "black" }) {
  const glyphs = GLYPHS[color];
  return (
    <div className="flex h-7 items-center gap-0.5 text-xl text-slate-300" aria-label={label}>
      {pieces.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: captured pieces are append-only and never reordered, so the index is a stable key.
        <span key={`${p}-${i}`}>{glyphs[p] ?? "?"}</span>
      ))}
    </div>
  );
}
