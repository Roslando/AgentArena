import type { Color, MatchState, PlayerView } from "../state/types";
import { BrandMark } from "./BrandMark";
import { ProviderLogo } from "./ProviderLogo";

/** Standard chess material values (king is never captured). */
const PIECE_VALUE: Record<string, number> = {
  pawn: 1,
  knight: 3,
  bishop: 3,
  rook: 5,
  queen: 9,
};

const materialOf = (pieces: string[]): number =>
  pieces.reduce((sum, p) => sum + (PIECE_VALUE[p] ?? 0), 0);

export function TopBar({
  state,
  isLive,
  connected,
}: {
  state: MatchState;
  isLive: boolean;
  connected: boolean;
}) {
  const [left, right] = state.players;
  // A player's score = value of pieces they captured = the OPPONENT's losses.
  // (state.capturedByWhite holds White's *losses*, per the MCP server convention.)
  const scoreFor = (color: Color): number =>
    materialOf(color === "white" ? state.capturedByBlack : state.capturedByWhite);

  return (
    <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-slate-800 bg-slate-950/80 px-5 py-3">
      <span className="flex items-center gap-2 text-lg font-bold tracking-tight text-slate-100">
        <BrandMark size={22} />
        AgentArena
      </span>

      {left && right ? (
        <Scoreboard
          left={left}
          right={right}
          leftScore={scoreFor(left.color)}
          rightScore={scoreFor(right.color)}
          winnerId={state.winnerId}
        />
      ) : (
        <span />
      )}

      <div className="flex justify-end">
        <StatusBadge status={state.status} isLive={isLive} connected={connected} />
      </div>
    </header>
  );
}

/** Centered esports scoreboard: name+logo · live material score · name+logo. */
function Scoreboard({
  left,
  right,
  leftScore,
  rightScore,
  winnerId,
}: {
  left: PlayerView;
  right: PlayerView;
  leftScore: number;
  rightScore: number;
  winnerId: string | null;
}) {
  // The side with more captured material is leading.
  const leadClass = (mine: number, other: number) =>
    mine > other ? "text-emerald-300" : "text-slate-200";

  return (
    <div className="flex items-center gap-3 sm:gap-5">
      <Side player={left} side="left" won={winnerId === left.id} />
      <div
        className="flex items-center gap-2 font-bold tabular-nums"
        title="Material score (captured-piece value)"
      >
        <span className={leadClass(leftScore, rightScore)}>{leftScore}</span>
        <span className="text-slate-600">–</span>
        <span className={leadClass(rightScore, leftScore)}>{rightScore}</span>
      </div>
      <Side player={right} side="right" won={winnerId === right.id} />
    </div>
  );
}

function Side({
  player,
  side,
  won,
}: {
  player: PlayerView;
  side: "left" | "right";
  won: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 ${side === "right" ? "flex-row-reverse" : ""}`}>
      <ProviderLogo provider={player.providerType} model={player.model} size={24} />
      <span className="hidden truncate text-sm font-semibold text-slate-100 sm:inline">
        {player.name}
        {won && " 👑"}
      </span>
    </div>
  );
}

const BADGE_BASE =
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ring-1 backdrop-blur-md";

function StatusBadge({
  status,
  isLive,
  connected,
}: {
  status: MatchState["status"];
  isLive: boolean;
  connected: boolean;
}) {
  if (isLive && status !== "over") {
    return connected ? (
      <span className={`${BADGE_BASE} bg-rose-500/10 text-rose-300 ring-rose-400/30`}>
        <PingDot color="bg-rose-400" /> Live
      </span>
    ) : (
      <span className={`${BADGE_BASE} bg-amber-500/10 text-amber-300 ring-amber-400/30`}>
        <PingDot color="bg-amber-400" /> Connecting…
      </span>
    );
  }
  if (status === "live") {
    return (
      <span className={`${BADGE_BASE} bg-sky-500/10 text-sky-300 ring-sky-400/30`}>
        <PlayGlyph /> Replay
      </span>
    );
  }
  if (status === "over") {
    return (
      <span className={`${BADGE_BASE} bg-emerald-500/10 text-emerald-300 ring-emerald-400/30`}>
        <CheckGlyph /> Finished
      </span>
    );
  }
  return (
    <span className={`${BADGE_BASE} bg-slate-700/30 text-slate-400 ring-slate-500/20`}>Idle</span>
  );
}

/** Expanding "live" dot — pulse ring on a pseudo-element (cheap CSS, respects reduced motion). */
function PingDot({ color }: { color: string }) {
  return (
    <span className="relative flex h-2 w-2">
      <span
        className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 motion-reduce:animate-none ${color}`}
      />
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}

function PlayGlyph() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4.5 3c0-.5.55-.8.97-.53l7 4.5a.63.63 0 0 1 0 1.06l-7 4.5A.63.63 0 0 1 4.5 12z" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5l3.2 3.2L13 4.5" />
    </svg>
  );
}
