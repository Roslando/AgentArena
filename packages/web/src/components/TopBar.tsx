import type { MatchState } from "../state/types";

export function TopBar({ state, onLoad }: { state: MatchState; onLoad: (raw: string) => void }) {
  return (
    <header className="flex items-center justify-between border-b border-slate-800 bg-slate-950/80 px-5 py-3">
      <div className="flex items-center gap-3">
        <span className="text-lg font-bold tracking-tight text-slate-100">⚔ AgentArena</span>
        {state.matchId && (
          <span className="text-sm text-slate-500">
            ♟ {state.game ?? "chess"} · {state.matchId}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <StatusBadge status={state.status} />
        <label className="cursor-pointer rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">
          Load .jsonl
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
    </header>
  );
}

function StatusBadge({ status }: { status: MatchState["status"] }) {
  if (status === "live") {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-rose-500/15 px-2.5 py-0.5 text-xs font-semibold text-rose-300">
        <span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" /> REPLAY
      </span>
    );
  }
  if (status === "over") {
    return (
      <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-300">
        FINISHED
      </span>
    );
  }
  return (
    <span className="rounded-full bg-slate-700/40 px-2.5 py-0.5 text-xs font-semibold text-slate-400">
      IDLE
    </span>
  );
}
