import type { MatchState, PlayerView } from "../state/types";
import { ProviderLogo } from "./ProviderLogo";

function fmtMs(ms: number): string {
  if (ms <= 0) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** End-of-match comparison card. */
export function SummaryModal({
  state,
  onClose,
}: {
  state: MatchState;
  onClose: () => void;
}) {
  if (state.status !== "over") return null;
  const winner = state.players.find((p) => p.id === state.winnerId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
        <div className="mb-1 text-center text-sm uppercase tracking-widest text-slate-500">
          Match finished
        </div>
        <div className="mb-6 text-center text-2xl font-bold text-slate-100">
          {winner ? `👑 ${winner.name} wins` : "Draw"}
          <div className="mt-1 text-sm font-normal text-slate-500">{state.endReason}</div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {state.players.map((p) => (
            <PlayerSummary key={p.id} p={p} highlight={p.id === state.winnerId} />
          ))}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-6 w-full rounded-lg bg-sky-500 py-2 font-semibold text-slate-950 hover:bg-sky-400"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function PlayerSummary({ p, highlight }: { p: PlayerView; highlight: boolean }) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        highlight ? "border-emerald-500/50 bg-emerald-500/5" : "border-slate-700 bg-slate-800/40"
      }`}
    >
      <div className="mb-3 flex items-center gap-2">
        <ProviderLogo provider={p.providerType} size={24} />
        <span className="truncate font-semibold text-slate-100">{p.name}</span>
      </div>
      <Row label="Turns" value={String(p.turns)} />
      <Row label="Avg reflection" value={fmtMs(p.avgLlmLatencyMs)} />
      <Row label="Total reflection" value={fmtMs(p.totalLlmLatencyMs)} />
      <Row label="Tokens in" value={String(p.tokensInput)} />
      <Row label="Tokens out" value={String(p.tokensOutput)} />
      <Row label="Faults" value={`${p.faults}/3`} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-0.5 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-200">{value}</span>
    </div>
  );
}
