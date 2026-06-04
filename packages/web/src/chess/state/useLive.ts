import type { LogEntry } from "@agentarena/types";
import { useEffect, useReducer, useState } from "react";
import { matchReducer } from "./matchReducer";
import { initialMatchState } from "./types";

const SERVER = import.meta.env.VITE_SERVER_URL ?? "http://localhost:7070";

/**
 * Live match state: connects to the server WebSocket and folds each incoming
 * LogEntry through the SAME reducer used for replay, so rendering is identical.
 */
export function useLive(matchId: string | null) {
  const [state, dispatch] = useReducer(matchReducer, undefined, initialMatchState);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!matchId) return;
    const wsUrl = `${SERVER.replace(/^http/, "ws")}/ws?matchId=${encodeURIComponent(matchId)}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (ev) => {
      try {
        dispatch(JSON.parse(ev.data) as LogEntry);
      } catch {
        /* ignore malformed frame */
      }
    };

    return () => ws.close();
  }, [matchId]);

  return { state, connected };
}
