import { useEffect, useRef, useState } from "react";
import type { ChatMessage, Color } from "../state/types";

/**
 * Activity-feed reasoning view: the NEWEST utterance sits at the top so the
 * current move's thinking is always in view; older messages flow downward.
 * The feed stays pinned to the top unless the user scrolls down to read history,
 * in which case a "new message" pill appears instead of yanking them back up.
 */
export function ChatThread({
  messages,
  thinking,
  color,
  side,
}: {
  messages: ChatMessage[];
  thinking: boolean;
  color: Color;
  side: "left" | "right";
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the user is pinned to the top (read via ref to avoid stale closures).
  const atTopRef = useRef(true);
  // True when older messages overflow below the fold (drives the bottom fade).
  const [overflowing, setOverflowing] = useState(false);
  // True when a new message arrived while the user was reading older ones below.
  const [hasNew, setHasNew] = useState(false);

  const scrollToTop = (smooth = false) => {
    scrollRef.current?.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
  };

  // Follow the feed only if the user is at the top; otherwise surface the pill.
  // biome-ignore lint/correctness/useExhaustiveDependencies: react to new content only
  useEffect(() => {
    if (atTopRef.current) scrollToTop();
    else setHasNew(true);
    const el = scrollRef.current;
    if (el) setOverflowing(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
  }, [messages.length, thinking]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    atTopRef.current = el.scrollTop < 4;
    setOverflowing(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
    if (atTopRef.current) setHasNew(false);
  };

  const jumpToTop = () => {
    scrollToTop(true);
    setHasNew(false);
  };

  const bubble =
    color === "white" ? "border-sky-500/40 bg-sky-500/10" : "border-rose-500/40 bg-rose-500/10";
  const rowAlign = side === "right" ? "items-end" : "items-start";
  const empty = messages.length === 0 && !thinking;

  // Newest first.
  const ordered = [...messages].reverse();

  return (
    <div className="relative w-full">
      {hasNew && (
        <button
          type="button"
          onClick={jumpToTop}
          className="absolute inset-x-0 top-2 z-20 mx-auto w-fit rounded-full bg-sky-500 px-3 py-1 text-xs font-medium text-slate-950 shadow-lg hover:bg-sky-400"
        >
          ↑ new message
        </button>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={`no-scrollbar flex max-h-72 flex-col gap-2 overflow-y-auto pr-1 ${rowAlign}`}
      >
        {empty && (
          <div className="w-full py-6 text-center text-xs text-slate-600">No reasoning yet</div>
        )}

        {thinking && (
          <div
            className={`flex items-center gap-1.5 rounded-2xl border px-3.5 py-2.5 ${bubble} ${
              side === "right" ? "rounded-tr-sm" : "rounded-tl-sm"
            }`}
          >
            <Dot delay="0ms" />
            <Dot delay="150ms" />
            <Dot delay="300ms" />
          </div>
        )}

        {ordered.map((m) => (
          <div
            key={m.turn}
            className={`max-w-[92%] rounded-2xl border px-3.5 py-2 text-sm leading-relaxed text-slate-100 ${bubble} ${
              side === "right" ? "rounded-tr-sm" : "rounded-tl-sm"
            }`}
          >
            <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              turn {m.turn}
            </div>
            {m.text}
          </div>
        ))}
      </div>

      {/* bottom fade so older messages dissolve downward instead of cutting hard */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-slate-950 to-transparent transition-opacity duration-200"
        style={{ opacity: overflowing ? 1 : 0 }}
      />
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
