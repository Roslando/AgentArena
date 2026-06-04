/**
 * AgentArena mark — a simplified tiered amphitheater cradling an "A".
 *
 * Monochrome via `currentColor`, so it inherits the surrounding text color:
 * near-white on the dark broadcast UI, ink on the light report card. Pure SVG,
 * crisp from favicon to banner, ~1 KB.
 */
export function BrandMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={4.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="AgentArena"
      className={className}
    >
      {/* arena tiers (open at the bottom) */}
      <path d="M8 36 A24 20 0 0 1 56 36" />
      <path d="M18 36 A15 12 0 0 1 46 36" />
      {/* the "A" nested in the arena */}
      <path d="M23 50 L32 23 L41 50" strokeWidth={5} />
      <path d="M26.8 40 H37.2" strokeWidth={5} />
    </svg>
  );
}
