/** Floating glass "pill" transport: a slim seek bar under the board (replay only). */
export function MoveTimeline({
  cursor,
  total,
  playing,
  speed,
  onToggle,
  onSeek,
  onSpeed,
  onLoad,
}: {
  cursor: number;
  total: number;
  playing: boolean;
  speed: number;
  onToggle: () => void;
  onSeek: (i: number) => void;
  onSpeed: (s: number) => void;
  onLoad: (raw: string) => void;
}) {
  return (
    <div className="flex w-[min(88vw,52vh,500px)] items-center gap-3 rounded-full border border-white/10 bg-slate-900/55 px-3 py-2 shadow-lg backdrop-blur-md">
      <button
        type="button"
        onClick={onToggle}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-sky-500 text-slate-950 transition hover:bg-sky-400"
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      <input
        type="range"
        min={0}
        max={total}
        value={cursor}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-slate-700 accent-sky-400"
        aria-label="Scrub timeline"
      />

      {/* Options group, set apart from the transport controls. */}
      <span className="h-5 w-px shrink-0 bg-white/10" />

      <select
        value={speed}
        onChange={(e) => onSpeed(Number(e.target.value))}
        className="shrink-0 rounded-full bg-white/5 px-2 py-1 text-xs text-slate-200 outline-none transition hover:bg-white/10"
        aria-label="Playback speed"
      >
        <option value={0.5}>0.5×</option>
        <option value={1}>1×</option>
        <option value={2}>2×</option>
        <option value={4}>4×</option>
      </select>

      <label
        className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-full bg-white/5 text-slate-300 transition hover:bg-white/10 hover:text-slate-100"
        title="Load a match log (.jsonl)"
      >
        <ImportIcon />
        <input
          type="file"
          accept=".jsonl,.json,.log,.txt"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) onLoad(await file.text());
          }}
        />
      </label>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4.5 2.7c0-.6.65-.98 1.16-.66l8 5.3a.8.8 0 0 1 0 1.32l-8 5.3A.8.8 0 0 1 4.5 13.3z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="2.5" width="3.5" height="11" rx="1.2" />
      <rect x="9" y="2.5" width="3.5" height="11" rx="1.2" />
    </svg>
  );
}

/** Down-into-tray = "load a file from disk" (import), distinct from a share/export glyph. */
function ImportIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5V9.5M5 6.5l3 3 3-3" />
      <path d="M2.5 10.5v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1.5" />
    </svg>
  );
}
