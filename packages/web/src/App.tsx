import { useEffect, useState } from "react";
import { BoardView } from "./components/BoardView";
import { MoveTimeline } from "./components/MoveTimeline";
import { PlayerPanel } from "./components/PlayerPanel";
import { SummaryModal } from "./components/SummaryModal";
import { TopBar } from "./components/TopBar";
import { parseJsonl, useReplay } from "./state/useReplay";

export default function App() {
  const [entries, setEntries] = useState<ReturnType<typeof parseJsonl>>([]);
  const [showSummary, setShowSummary] = useState(true);

  // Auto-load the bundled sample match so the arena is never empty on first open.
  useEffect(() => {
    let cancelled = false;
    fetch("/samples/sample-foolsmate.jsonl")
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((raw) => {
        if (!cancelled) setEntries(parseJsonl(raw));
      })
      .catch(() => {
        /* no sample available — user can load a file manually */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const replay = useReplay(entries);
  const { state } = replay;

  const left = state.players[0];
  const right = state.players[1];

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-200">
      <TopBar
        state={state}
        onLoad={(raw) => {
          setEntries(parseJsonl(raw));
          setShowSummary(true);
        }}
      />

      <main className="flex flex-1 items-center justify-center gap-8 overflow-hidden px-8 py-6">
        {left ? (
          <PlayerPanel player={left} side="left" isWinner={state.winnerId === left.id} />
        ) : (
          <EmptyHint />
        )}

        <BoardView state={state} />

        {right && <PlayerPanel player={right} side="right" isWinner={state.winnerId === right.id} />}
      </main>

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

      {showSummary && <SummaryModal state={state} onClose={() => setShowSummary(false)} />}
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="w-72 text-center text-sm text-slate-600">
      Load a match log (<code className="text-slate-400">logs/*.jsonl</code>) to begin the replay.
    </div>
  );
}
