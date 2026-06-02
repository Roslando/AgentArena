import { useEffect, useState } from "react";
import { BoardView } from "./components/BoardView";
import { MoveTimeline } from "./components/MoveTimeline";
import { PlayerPanel } from "./components/PlayerPanel";
import { SummaryModal } from "./components/SummaryModal";
import { TopBar } from "./components/TopBar";
import { useLive } from "./state/useLive";
import { parseJsonl, useReplay } from "./state/useReplay";

/** Live match id from ?live=<matchId>; null means replay mode. */
function liveIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("live");
}

export default function App() {
  const liveId = liveIdFromUrl();
  const isLive = liveId !== null;

  const [entries, setEntries] = useState<ReturnType<typeof parseJsonl>>([]);
  const [showSummary, setShowSummary] = useState(true);

  // Replay only: auto-load the bundled sample so the arena is never empty.
  useEffect(() => {
    if (isLive) return;
    let cancelled = false;
    fetch("/samples/sample-foolsmate.jsonl")
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((raw) => !cancelled && setEntries(parseJsonl(raw)))
      .catch(() => {
        /* no sample — user can load a file manually */
      });
    return () => {
      cancelled = true;
    };
  }, [isLive]);

  // Both hooks always run (rules of hooks); the inactive one stays idle.
  const replay = useReplay(isLive ? [] : entries);
  const live = useLive(isLive ? liveId : null);

  const state = isLive ? live.state : replay.state;
  const left = state.players[0];
  const right = state.players[1];

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-200">
      <TopBar
        state={state}
        isLive={isLive}
        connected={live.connected}
        onLoad={(raw) => {
          setEntries(parseJsonl(raw));
          setShowSummary(true);
        }}
      />

      <main className="flex flex-1 flex-col items-center justify-start gap-5 overflow-auto px-4 py-5 lg:flex-row lg:items-center lg:justify-center lg:gap-8 lg:overflow-hidden lg:px-8">
        {left ? (
          <PlayerPanel player={left} side="left" isWinner={state.winnerId === left.id} />
        ) : (
          <EmptyHint isLive={isLive} />
        )}

        <BoardView state={state} />

        {right && <PlayerPanel player={right} side="right" isWinner={state.winnerId === right.id} />}
      </main>

      {isLive ? (
        <LiveStatusBar state={state} />
      ) : (
        <MoveTimeline
          moves={state.moves}
          cursor={replay.cursor}
          total={replay.total}
          playing={replay.playing}
          speed={replay.speed}
          onToggle={replay.toggle}
          onSeek={replay.seek}
          onSpeed={replay.setSpeed}
        />
      )}

      {showSummary && <SummaryModal state={state} onClose={() => setShowSummary(false)} />}
    </div>
  );
}

function LiveStatusBar({ state }: { state: ReturnType<typeof useLive>["state"] }) {
  const moves = state.moves.map((m) => m.san).join("  ");
  return (
    <div className="flex items-center gap-3 border-t border-slate-800 bg-slate-950/80 px-5 py-3 text-sm">
      <span className="flex items-center gap-1.5 font-semibold text-rose-300">
        <span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" /> LIVE
      </span>
      <span className="truncate text-slate-400">{moves || "waiting for first move…"}</span>
    </div>
  );
}

function EmptyHint({ isLive }: { isLive: boolean }) {
  return (
    <div className="w-72 text-center text-sm text-slate-600">
      {isLive ? (
        "Connecting to live match…"
      ) : (
        <>
          Load a match log (<code className="text-slate-400">logs/*.jsonl</code>) to begin the replay.
        </>
      )}
    </div>
  );
}
