import type { LogEntry } from "@agentarena/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { foldEntries } from "./matchReducer";
import { initialMatchState } from "./types";

/** Parse a raw .jsonl string into a typed LogEntry array (skips blank/invalid lines). */
export function parseJsonl(raw: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as LogEntry);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

const BASE_INTERVAL_MS = 700;

/**
 * Replay driver: folds the entry log up to a cursor and steps it forward on a timer.
 * Scrubbing recomputes from scratch (the reducer is pure), so it is always correct.
 */
export function useReplay(entries: LogEntry[]) {
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const total = entries.length;
  const state = useMemo(
    () => foldEntries(initialMatchState(), entries, cursor),
    [entries, cursor],
  );

  // Reset when a new log is loaded
  useEffect(() => {
    setCursor(0);
    setPlaying(entries.length > 0);
  }, [entries]);

  useEffect(() => {
    if (!playing) return;
    if (cursor >= total) {
      setPlaying(false);
      return;
    }
    timer.current = setTimeout(() => setCursor((c) => c + 1), BASE_INTERVAL_MS / speed);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [playing, cursor, total, speed]);

  return {
    state,
    cursor,
    total,
    playing,
    speed,
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    toggle: () => setPlaying((p) => !p),
    seek: (i: number) => {
      setPlaying(false);
      setCursor(Math.max(0, Math.min(total, i)));
    },
    setSpeed,
  };
}
