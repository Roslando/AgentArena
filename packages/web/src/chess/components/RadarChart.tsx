import { useEffect, useState } from "react";
import { useReducedMotion } from "../state/useReducedMotion";

/** One overlaid profile on the radar (values already normalized to 0–100). */
export interface RadarSeries {
  name: string;
  color: string;
  values: number[];
}

/** Eased 0→1 reveal so the profiles grow from the center on mount (skipped if reduced motion). */
function useGrowProgress(): number {
  const reduced = useReducedMotion();
  const [progress, setProgress] = useState(reduced ? 1 : 0);

  useEffect(() => {
    if (reduced) {
      setProgress(1);
      return;
    }
    const DURATION = 650;
    const start = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / DURATION);
      setProgress(1 - (1 - t) ** 3); // easeOutCubic
      if (t < 1) raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  return progress;
}

/**
 * Minimal, dependency-free radar (spider) chart in pure SVG.
 *
 * Built for the end-of-match report: a few axes, two overlaid profiles. The
 * SHAPE is the message — exact numbers live in the companion table next to it.
 */
export function RadarChart({
  axes,
  series,
  size = 320,
}: {
  axes: string[];
  series: RadarSeries[];
  size?: number;
}) {
  const progress = useGrowProgress();
  // Extra horizontal room so side labels (e.g. "Reliability") never clip,
  // while keeping the chart compact enough to leave the table room to breathe.
  const hpad = 56;
  const w = size + hpad * 2;
  const cx = w / 2;
  const cy = size / 2;
  const r = size / 2 - 24;
  const n = axes.length;

  const angle = (i: number) => (-90 + (360 / n) * i) * (Math.PI / 180);
  const at = (i: number, radius: number) => ({
    x: cx + radius * Math.cos(angle(i)),
    y: cy + radius * Math.sin(angle(i)),
  });
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const ringPoints = (f: number) =>
    axes.map((_, i) => `${at(i, r * f).x},${at(i, r * f).y}`).join(" ");
  const seriesPoints = (values: number[]) =>
    values.map((v, i) => `${at(i, (r * clamp(v)) / 100).x},${at(i, (r * clamp(v)) / 100).y}`).join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${size}`} width={w} height={size} role="img" aria-label="Profile comparison">
      {/* concentric reference rings */}
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <polygon key={f} points={ringPoints(f)} fill="none" stroke="#DEDBD1" strokeWidth={1} />
      ))}

      {/* spokes + axis labels */}
      {axes.map((label, i) => {
        const edge = at(i, r);
        const lab = at(i, r + 20);
        const anchor = Math.abs(lab.x - cx) < 8 ? "middle" : lab.x > cx ? "start" : "end";
        return (
          <g key={label}>
            <line x1={cx} y1={cy} x2={edge.x} y2={edge.y} stroke="#E7E4DB" strokeWidth={1} />
            <text
              x={lab.x}
              y={lab.y}
              textAnchor={anchor}
              dominantBaseline="middle"
              fontSize={10.5}
              fontWeight={600}
              letterSpacing="0.04em"
              fill="#7A776E"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              {label}
            </text>
          </g>
        );
      })}

      {/* overlaid profiles — grown from the center via `progress` (0→1 on mount) */}
      {series.map((s) => (
        <g key={s.name}>
          <polygon
            points={seriesPoints(s.values.map((v) => v * progress))}
            fill={s.color}
            fillOpacity={0.15}
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {s.values.map((v, i) => {
            const p = at(i, (r * clamp(v * progress)) / 100);
            return <circle key={axes[i]} cx={p.x} cy={p.y} r={3} fill={s.color} />;
          })}
        </g>
      ))}
    </svg>
  );
}
