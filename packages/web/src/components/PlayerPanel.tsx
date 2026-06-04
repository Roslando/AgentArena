import { costUsd, fmtTokens, fmtUsd } from "../state/metrics";
import type { PlayerView } from "../state/types";
import { ChatThread } from "./ChatThread";
import { ProviderLogo } from "./ProviderLogo";

/** One side of the broadcast: identity, color, and the live reasoning thread. */
export function PlayerPanel({
  player,
  side,
  isWinner,
}: {
  player: PlayerView;
  side: "left" | "right";
  isWinner: boolean;
}) {
  // On mobile both panels are centered & full-width; on desktop they hug the board edges.
  const align =
    side === "left"
      ? "items-center text-center lg:items-start lg:text-left"
      : "items-center text-center lg:items-end lg:text-right";
  const colorChip = player.color === "white" ? "♔ White" : "♚ Black";
  const cost = costUsd(player);
  const totalTokens = player.tokensInput + player.tokensOutput;

  return (
    <aside className={`flex w-full max-w-sm shrink-0 flex-col gap-4 lg:w-72 ${align}`}>
      <div className={`flex items-center gap-3 ${side === "right" ? "flex-row-reverse" : ""}`}>
        <ProviderLogo provider={player.providerType} model={player.model} size={36} />
        <div className={side === "right" ? "text-right" : ""}>
          <div className="flex items-center gap-2 font-semibold text-slate-100">
            {player.name}
            {isWinner && <span title="Winner">👑</span>}
          </div>
          <div className="text-xs text-slate-500">{player.model}</div>
        </div>
      </div>

      <div className={`flex items-center gap-2.5 ${side === "right" ? "flex-row-reverse" : ""}`}>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            player.color === "white"
              ? "bg-sky-500/15 text-sky-300"
              : "bg-rose-500/15 text-rose-300"
          }`}
        >
          {colorChip}
        </span>
        <span className="font-mono text-xs tabular-nums text-slate-400">
          {cost !== null && <span className="text-emerald-300">{fmtUsd(cost)}</span>}
          {cost !== null && <span className="text-slate-600"> · </span>}
          {fmtTokens(totalTokens)} tok
        </span>
      </div>

      <ChatThread
        messages={player.messages}
        thinking={player.thinking}
        color={player.color}
        side={side}
      />
    </aside>
  );
}
