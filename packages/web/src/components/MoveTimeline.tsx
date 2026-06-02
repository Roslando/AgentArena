import type { MoveRecord } from "../state/types";

/** Bottom strip: SAN move history + replay transport controls. */
export function MoveTimeline({
  moves,
  cursor,
  total,
  playing,
  speed,
  onToggle,
  onSeek,
  onSpeed,
}: {
  moves: MoveRecord[];
  cursor: number;
  total: number;
  playing: boolean;
  speed: number;
  onToggle: () => void;
  onSeek: (i: number) => void;
  onSpeed: (s: number) => void;
}) {
  // Group plies into numbered pairs: "1. e4 e5"
  const pairs: { n: number; white?: string; black?: string }[] = [];
  for (const m of moves) {
    const n = Math.ceil(m.ply / 2);
    let pair = pairs[pairs.length - 1];
    if (!pair || pair.n !== n) {
      pair = { n };
      pairs.push(pair);
    }
    if (m.color === "white") pair.white = m.san;
    else pair.black = m.san;
  }

  return (
    <div className="flex items-center gap-4 border-t border-slate-800 bg-slate-950/80 px-5 py-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-sky-500 text-slate-950 hover:bg-sky-400"
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "❚❚" : "▶"}
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto whitespace-nowrap text-sm">
        {pairs.length === 0 && <span className="text-slate-600">No moves yet</span>}
        {pairs.map((p) => (
          <span key={p.n} className="text-slate-300">
            <span className="text-slate-600">{p.n}.</span> {p.white ?? ""}{" "}
            <span className="text-slate-400">{p.black ?? ""}</span>
          </span>
        ))}
      </div>

      <input
        type="range"
        min={0}
        max={total}
        value={cursor}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="w-40 accent-sky-500"
        aria-label="Scrub timeline"
      />

      <select
        value={speed}
        onChange={(e) => onSpeed(Number(e.target.value))}
        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200"
        aria-label="Playback speed"
      >
        <option value={0.5}>0.5×</option>
        <option value={1}>1×</option>
        <option value={2}>2×</option>
        <option value={4}>4×</option>
      </select>
    </div>
  );
}
