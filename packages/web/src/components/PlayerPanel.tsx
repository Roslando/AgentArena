import type { PlayerView } from "../state/types";
import { ProviderLogo } from "./ProviderLogo";
import { ReasoningBubble } from "./ReasoningBubble";
import { StatBadge } from "./StatBadge";

function fmtMs(ms: number): string {
  if (ms <= 0) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** One side of the broadcast: identity, live reasoning, and running stats. */
export function PlayerPanel({
  player,
  side,
  isWinner,
}: {
  player: PlayerView;
  side: "left" | "right";
  isWinner: boolean;
}) {
  const align = side === "left" ? "items-start text-left" : "items-end text-right";
  const colorChip = player.color === "white" ? "♔ White" : "♚ Black";

  return (
    <aside className={`flex w-72 shrink-0 flex-col gap-4 ${align}`}>
      <div className={`flex items-center gap-3 ${side === "right" ? "flex-row-reverse" : ""}`}>
        <ProviderLogo provider={player.providerType} size={36} />
        <div className={side === "right" ? "text-right" : ""}>
          <div className="flex items-center gap-2 font-semibold text-slate-100">
            {player.name}
            {isWinner && <span title="Winner">👑</span>}
          </div>
          <div className="text-xs text-slate-500">{player.model}</div>
        </div>
      </div>

      <div
        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
          player.color === "white"
            ? "bg-sky-500/15 text-sky-300"
            : "bg-rose-500/15 text-rose-300"
        }`}
      >
        {colorChip}
      </div>

      <div className="w-full">
        <ReasoningBubble text={player.reasoning} thinking={player.thinking} color={player.color} />
      </div>

      <div className="flex w-full flex-col gap-2">
        <StatBadge icon="⏱" label="avg reflection" value={fmtMs(player.avgLlmLatencyMs)} />
        <StatBadge
          icon="🔢"
          label="tokens"
          value={fmtTokens(player.tokensInput + player.tokensOutput)}
        />
        <StatBadge
          icon="⚠"
          label="faults"
          value={`${player.faults}/3`}
          warn={player.faults > 0}
        />
      </div>
    </aside>
  );
}
