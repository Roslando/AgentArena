import type { Color } from "../state/types";

/** The LLM's latest reasoning text, styled as a chat bubble pointing inward. */
export function ReasoningBubble({
  text,
  thinking,
  color,
}: {
  text: string;
  thinking: boolean;
  color: Color;
}) {
  const accent = color === "white" ? "border-sky-500/40" : "border-rose-500/40";

  if (thinking) {
    return (
      <div className={`rounded-xl border ${accent} bg-slate-900/60 px-4 py-3`}>
        <div className="flex items-center gap-1.5">
          <Dot delay="0ms" />
          <Dot delay="150ms" />
          <Dot delay="300ms" />
          <span className="ml-1 text-xs text-slate-400">thinking…</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`min-h-[64px] rounded-xl border ${accent} bg-slate-900/60 px-4 py-3 text-sm leading-relaxed text-slate-200`}
    >
      {text ? `"${text}"` : <span className="text-slate-500">—</span>}
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-2 w-2 animate-bounce rounded-full bg-slate-400"
      style={{ animationDelay: delay }}
    />
  );
}
