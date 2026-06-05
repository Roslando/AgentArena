import type {
  LlmProvider,
  LogEntry,
  MatchConfig,
  MatchStartEntry,
  ToolDefinition,
} from "@agentarena/types";
import { MatchLogger } from "./match-logger.js";
import { McpManager } from "./mcp-manager.js";
import { createProvider } from "./providers/factory.js";

interface LastMoveDetail {
  san: string;
  piece: string;
  from: string;
  to: string;
  captured: string | null;
  promotion: string | null;
  isCheck: boolean;
}

interface PlayerState {
  id: string;
  name: string;
  provider: ReturnType<typeof createProvider>;
  /** Per-player output cap; falls back to limits.maxTokensPerTurn when unset. */
  maxTokens: number | undefined;
  retries: number;
  turnCount: number;
  totalLlmLatencyMs: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  lastMoves: LastMoveDetail[];
  /** The player's own last few reasoning notes (plan memory), carried across turns. */
  notes: string[];
}

/**
 * Orchestrates a match between two or more LLM players on an MCP game server.
 *
 * The runner owns the match loop and is agnostic of game rules — it only
 * relays tool calls and errors between the LLM and the MCP server.
 */
export class MatchRunner {
  private players: PlayerState[] = [];
  private mcp: McpManager;
  private log: MatchLogger;
  private abortController = new AbortController();
  private startTime = 0;

  constructor(
    private readonly config: MatchConfig,
    onLogEntry?: (entry: LogEntry) => void,
  ) {
    this.log = new MatchLogger(config.matchId, undefined, onLogEntry);
    this.mcp = new McpManager(config.mcpServer, this.log, config.matchId);

    for (const p of config.players) {
      this.players.push({
        id: p.id,
        name: p.name,
        provider: createProvider(p.id, p.provider),
        maxTokens: p.maxTokens,
        retries: 0,
        turnCount: 0,
        totalLlmLatencyMs: 0,
        totalTokensInput: 0,
        totalTokensOutput: 0,
        lastMoves: [],
        notes: [],
      });
    }
  }

  /** Expose the log instance for external writes (e.g., mcp-manager). */
  get logger(): MatchLogger {
    return this.log;
  }

  /**
   * Run the full match to completion.
   */
  async run(): Promise<{ winnerId?: string; reason: string }> {
    this.startTime = Date.now();
    this.abortController = new AbortController();

    this.log.write({
      type: "match.start",
      t: new Date().toISOString(),
      matchId: this.config.matchId,
      players: this.config.players.map((p) => {
        const rosterEntry: MatchStartEntry["players"][number] = {
          id: p.id,
          name: p.name,
          providerType: p.provider.type,
          model: p.provider.model,
        };
        if (p.priceInputPerM !== undefined) rosterEntry.priceInputPerM = p.priceInputPerM;
        if (p.priceOutputPerM !== undefined) rosterEntry.priceOutputPerM = p.priceOutputPerM;
        return rosterEntry;
      }),
    });

    try {
      await this.mcp.connect();

      // Preflight: the configured state tool must exist and the server must
      // expose at least one action tool — fail fast before spending any tokens.
      const toolNames = this.mcp.tools.map((t) => t.name);
      if (!toolNames.includes(this.config.stateToolName)) {
        throw new Error(
          `MCP server exposes no "${this.config.stateToolName}" tool (stateToolName). Available: ${toolNames.join(", ") || "none"}`,
        );
      }
      if (toolNames.length < 2) {
        throw new Error(
          `MCP server exposes no action tool besides "${this.config.stateToolName}".`,
        );
      }

      // Build tool definitions for the LLMs
      const toolDefs: ToolDefinition[] = this.mcp.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: t.inputSchema as Record<string, unknown>,
        },
      }));

      // Fetch game-specific prompt from MCP server (null if not exposed)
      const mcpPrompt = await this.mcp.getSystemPrompt();

      // Give each player the system prompt once — 3-level fallback:
      // 1. configPlayer.systemPrompt  (explicit override in match.config.json)
      // 2. mcpPrompt                  (prompt exposed by the MCP game server)
      // 3. DEFAULT_SYSTEM_PROMPT      (generic global fallback)
      const histories: Array<Array<{ role: "system" | "user" | "assistant"; content: string }>> =
        this.players.map((player) => {
          const configPlayer = this.config.players.find((p) => p.id === player.id);
          const prompt = configPlayer?.systemPrompt ?? mcpPrompt ?? DEFAULT_SYSTEM_PROMPT;
          return [{ role: "system" as const, content: prompt }];
        });

      // Rotate through players until game over or timeout
      let currentPlayerIndex = 0;
      let turn = 0;

      while (!this.abortController.signal.aborted) {
        // Check global timer (optional — skipped entirely when no cap is set)
        if (
          this.config.limits.maxDurationMs !== undefined &&
          Date.now() - this.startTime > this.config.limits.maxDurationMs
        ) {
          return await this.endMatch("timeout", undefined);
        }

        const player = this.players[currentPlayerIndex];
        if (!player) break;
        const history = histories[currentPlayerIndex];
        if (!history) break;

        turn++;

        // Get game state from MCP
        const state = await this.mcp.callTool(this.config.stateToolName, {});
        const stateContent = extractTextContent(state);
        const boardJson = tryParseJson(stateContent);

        // Format minimal, self-contained user message: current board (always
        // complete) + the player's recent moves and plan notes (memory).
        if (boardJson) {
          const formatted = formatBoardMessage(
            turn,
            boardJson,
            player.lastMoves.at(-1) ?? null,
            player.lastMoves,
            player.notes,
          );
          history.push({ role: "user", content: formatted });
        } else {
          // Fallback: use raw state string
          history.push({ role: "user", content: `Turn ${turn}. Game state:\n${stateContent}` });
        }

        // Send to LLM — start high-resolution timer for latency tracking
        const llmStartTime = performance.now();
        this.log.write({
          type: "llm.sent",
          t: new Date().toISOString(),
          matchId: this.config.matchId,
          playerId: player.id,
          messageCount: history.length,
        });

        let response: Awaited<ReturnType<LlmProvider["send"]>>;
        try {
          response = await player.provider.send(history, toolDefs, {
            maxTokens: player.maxTokens ?? this.config.limits.maxTokensPerTurn,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.write({
            type: "llm.error",
            t: new Date().toISOString(),
            matchId: this.config.matchId,
            playerId: player.id,
            message,
          });

          player.retries++;
          if (player.retries >= this.config.limits.maxRetriesPerTurn) {
            this.log.write({
              type: "forfeit",
              t: new Date().toISOString(),
              matchId: this.config.matchId,
              playerId: player.id,
              reason: `LLM error after ${player.retries} retries: ${message}`,
            });
            return await this.endMatch("forfeit", this.getNextPlayer(currentPlayerIndex)?.id);
          }
          continue;
        }

        const llmLatencyMs = Math.round(performance.now() - llmStartTime);
        this.log.write({
          type: "llm.response",
          t: new Date().toISOString(),
          matchId: this.config.matchId,
          playerId: player.id,
          content: response.content,
          tokensInput: response.tokensInput,
          tokensOutput: response.tokensOutput,
          finishReason: response.finishReason,
          latencyMs: llmLatencyMs,
        });

        // Accumulate per-player stats
        player.turnCount++;
        player.totalLlmLatencyMs += llmLatencyMs;
        player.totalTokensInput += response.tokensInput;
        player.totalTokensOutput += response.tokensOutput;

        // Execute tool calls
        if (response.toolCalls.length > 0) {
          for (const tc of response.toolCalls) {
            let args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            let attempt = 0;

            while (attempt < this.config.limits.maxRetriesPerTurn) {
              this.log.write({
                type: "tool.call",
                t: new Date().toISOString(),
                matchId: this.config.matchId,
                playerId: player.id,
                toolName: tc.function.name,
                args,
                attempt: attempt + 1,
              });

              try {
                const mcpStart = performance.now();
                const result = await this.mcp.callTool(tc.function.name, args);
                const mcpLatencyMs = Math.round(performance.now() - mcpStart);

                // Check if the MCP signals game over
                const resultObj = result as Record<string, unknown> | undefined;
                if (resultObj?.game_over || resultObj?.gameOver) {
                  this.log.write({
                    type: "game.over",
                    t: new Date().toISOString(),
                    matchId: this.config.matchId,
                    playerId: player.id,
                    result: resultObj,
                  });

                  history.push({
                    role: "assistant",
                    content: response.content,
                  });

                  const rawWinnerId = (resultObj?.winner_id ?? resultObj?.winnerId) as
                    | string
                    | undefined;
                  return await this.endMatch("game_over", this.mapGameWinner(rawWinnerId));
                }

                // Illegal move — fault incremented by the game server, but turn is NOT over.
                // Notify the LLM and let it retry within the same turn.
                const resultContent = extractTextContent(result);
                const resultJson = tryParseJson(resultContent);

                if (resultJson?.accepted === false) {
                  attempt++;
                  if (attempt >= this.config.limits.maxRetriesPerTurn) {
                    // Safety cap — in practice the game server forfeits at 3 faults first
                    return await this.endMatch(
                      "forfeit",
                      this.getNextPlayer(currentPlayerIndex)?.id,
                    );
                  }

                  history.push({ role: "assistant", content: response.content });
                  history.push({
                    role: "user",
                    content: `Illegal move. Faults: ${String(resultJson.faults_total ?? "?")}/3. Try a different legal move.`,
                  });

                  // Re-send to LLM with the error context
                  try {
                    response = await player.provider.send(history, toolDefs, {
                      maxTokens: player.maxTokens ?? this.config.limits.maxTokensPerTurn,
                    });
                    // Extract new args from the LLM's corrected tool call
                    const newTc = response.toolCalls[0];
                    if (newTc) {
                      args = JSON.parse(newTc.function.arguments) as Record<string, unknown>;
                    }
                  } catch {
                    break; // LLM failed to respond — give up on this turn
                  }
                  continue; // Retry while loop with updated args
                }

                this.log.write({
                  type: "turn_metrics",
                  t: new Date().toISOString(),
                  matchId: this.config.matchId,
                  playerId: player.id,
                  llmLatencyMs,
                  mcpLatencyMs,
                  turnDurationMs: Math.round(performance.now() - llmStartTime),
                  turnNumber: turn,
                });
                if (resultJson?.san && resultJson?.piece_moved) {
                  const detail: LastMoveDetail = {
                    san: String(resultJson.san),
                    piece: String(resultJson.piece_moved),
                    from: String(resultJson.from),
                    to: String(resultJson.to),
                    captured: resultJson.captured ? String(resultJson.captured) : null,
                    promotion: resultJson.promotion ? String(resultJson.promotion) : null,
                    isCheck: Boolean(resultJson.is_check),
                  };
                  player.lastMoves.push(detail);
                  if (player.lastMoves.length > 3) {
                    player.lastMoves.shift();
                  }
                }

                // Remember the player's own reasoning (plan memory) for the next
                // few turns so it doesn't lose track of its intentions.
                const note = response.content.trim();
                if (note) {
                  player.notes.push(note);
                  if (player.notes.length > 3) {
                    player.notes.shift();
                  }
                }

                // Inject tool result into history for next turn
                history.push({
                  role: "assistant",
                  content: response.content,
                });
                history.push({
                  role: "user",
                  content: `Tool result: ${resultContent}`,
                });

                // Reset per turn: the next turn rebuilds a self-contained message
                // (fresh board + recent moves + plan notes). No stale board lingers.
                pruneHistory(history);
                // Clean move played → clear this player's strike counter so the
                // retry budget is truly per-turn (a single earlier hiccup never
                // accumulates into a spurious forfeit dozens of moves later).
                player.retries = 0;

                break; // success, exit retry loop
              } catch (err) {
                attempt++;
                const message = err instanceof Error ? err.message : String(err);

                this.log.write({
                  type: "tool.error",
                  t: new Date().toISOString(),
                  matchId: this.config.matchId,
                  playerId: player.id,
                  toolName: tc.function.name,
                  error: message,
                  attempt,
                });

                if (attempt >= this.config.limits.maxRetriesPerTurn) {
                  this.log.write({
                    type: "forfeit",
                    t: new Date().toISOString(),
                    matchId: this.config.matchId,
                    playerId: player.id,
                    reason: `Tool error after ${attempt} retries: ${message}`,
                  });
                  return await this.endMatch("forfeit", this.getNextPlayer(currentPlayerIndex)?.id);
                }

                // Re-prompt LLM with error for correction
                history.push({
                  role: "assistant",
                  content: response.content,
                });
                history.push({
                  role: "user",
                  content: `Tool call error: ${message}. Please respond with a corrected move.`,
                });

                // Re-send to LLM
                try {
                  response = await player.provider.send(history, toolDefs, {
                    maxTokens: player.maxTokens ?? this.config.limits.maxTokensPerTurn,
                  });
                } catch {
                  break;
                }
              }
            }
          }
        } else {
          // No tool call → the model produced no move this turn (its output was
          // truncated at maxTokens, or it replied with text only). A turn MUST
          // yield a move, so we retry the SAME player and never rotate: the game
          // server applies moves by side-to-move, so handing the turn to the
          // opponent would let one model play BOTH colors. Forfeit this player
          // only if it keeps failing to move.
          player.retries++;
          if (player.retries >= this.config.limits.maxRetriesPerTurn) {
            this.log.write({
              type: "forfeit",
              t: new Date().toISOString(),
              matchId: this.config.matchId,
              playerId: player.id,
              reason: `No move produced after ${player.retries} attempts (finishReason: ${response.finishReason ?? "unknown"})`,
            });
            return await this.endMatch("forfeit", this.getNextPlayer(currentPlayerIndex)?.id);
          }
          pruneHistory(history);
          continue; // retry the same player; do NOT rotate to the opponent
        }

        // Rotate to next player
        currentPlayerIndex = (currentPlayerIndex + 1) % this.players.length;
      }

      return await this.endMatch("unknown", undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.write({
        type: "mcp.error",
        t: new Date().toISOString(),
        matchId: this.config.matchId,
        message,
      });
      return await this.endMatch("error", undefined);
    } finally {
      await this.mcp.disconnect();
    }
  }

  private getNextPlayer(currentIndex: number): PlayerState | undefined {
    return this.players[(currentIndex + 1) % this.players.length];
  }

  /**
   * Map game-server color IDs ("white"/"black") to actual player IDs.
   * In a 2-player match, player[0] = white, player[1] = black.
   */
  private mapGameWinner(rawWinnerId?: string): string | undefined {
    if (rawWinnerId === undefined) return undefined;
    if (this.players.some((p) => p.id === rawWinnerId)) return rawWinnerId;
    if (this.players.length === 2) {
      if (rawWinnerId === "white") return this.players[0]?.id;
      if (rawWinnerId === "black") return this.players[1]?.id;
    }
    return rawWinnerId;
  }

  private async endMatch(
    reason: string,
    winnerId_?: string,
  ): Promise<{ winnerId?: string; reason: string }> {
    // Write per-player aggregated stats before the final match.end entry
    this.log.write({
      type: "match.summary",
      t: new Date().toISOString(),
      matchId: this.config.matchId,
      matchDurationMs: Date.now() - this.startTime,
      players: this.players.map((p) => ({
        playerId: p.id,
        turns: p.turnCount,
        totalLlmLatencyMs: p.totalLlmLatencyMs,
        avgLlmLatencyMs: p.turnCount > 0 ? Math.round(p.totalLlmLatencyMs / p.turnCount) : 0,
        totalTokensInput: p.totalTokensInput,
        totalTokensOutput: p.totalTokensOutput,
        totalTokens: p.totalTokensInput + p.totalTokensOutput,
      })),
    });

    const entry: LogEntry = {
      type: "match.end",
      t: new Date().toISOString(),
      matchId: this.config.matchId,
      reason,
    };
    if (winnerId_ !== undefined) {
      (entry as { winnerId?: string }).winnerId = winnerId_;
    }
    this.log.write(entry);
    this.abortController.abort();
    const res: { winnerId?: string; reason: string } = { reason };
    if (winnerId_ !== undefined) res.winnerId = winnerId_;
    return res;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  "You are an AI agent competing in a game.\n" +
  "Analyze the current game state, then call the appropriate tool to take your action.\n" +
  "One sentence stating your action and your short-term intention (shown back to you " +
  "next turn), then the tool call. No lists. No JSON. No long explanations.";

/**
 * Extract text content from an MCP callTool result.
 */
function extractTextContent(result: unknown): string {
  const obj = result as Record<string, unknown> | undefined;
  if (obj?.content && Array.isArray(obj.content)) {
    for (const item of obj.content) {
      const i = item as Record<string, unknown> | undefined;
      if (i?.type === "text" && typeof i.text === "string") {
        return i.text;
      }
    }
  }
  return typeof result === "string" ? result : JSON.stringify(result);
}

/**
 * Try to parse a JSON string, returning null on failure.
 */
function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format a self-contained board message from the MCP get_board JSON response.
 *
 * The board is always complete, so we never carry stale boards across turns.
 * Instead we append the player's own recent moves (factual memory) and recent
 * reasoning notes (plan memory) so the agent keeps track of its intentions.
 */
function formatBoardMessage(
  turn: number,
  board: Record<string, unknown>,
  lastOpponentMove: LastMoveDetail | null,
  recentMoves: LastMoveDetail[],
  recentNotes: string[],
): string {
  const color = String(board.you_are ?? "?");
  const faults = Number(board.your_faults ?? 0);
  const check = Boolean(board.check);
  const checkmate = Boolean(board.checkmate);
  const stalemate = Boolean(board.stalemate);
  const ascii = String(board.ascii ?? "");
  const lastSan = board.last_move_san ? String(board.last_move_san) : null;

  let msg = `Turn ${turn}. You play ${color}.\n`;
  msg += `Faults: ${faults}/3.\n`;

  if (lastSan && lastOpponentMove) {
    const advColor = color === "white" ? "Black" : "White";
    msg += `\n${formatLastLine(lastSan, lastOpponentMove, advColor)}\n`;
  }

  msg += `\n${ascii}\n\n`;
  msg += `Check: ${check}. Checkmate: ${checkmate}. Stalemate: ${stalemate}.`;

  if (recentMoves.length > 0) {
    msg += `\n\nYour recent moves: ${recentMoves.map((m) => m.san).join(", ")}.`;
  }
  if (recentNotes.length > 0) {
    msg += "\nYour recent notes (oldest first):";
    for (const n of recentNotes) msg += `\n- ${n}`;
  }

  return msg;
}

/**
 * Format the "Last:" line with move details.
 * Examples:
 *   Last: e4 (Black: pawn e2→e4)
 *   Last: exd5 (Black: pawn e4 takes pawn on d5)
 *   Last: O-O (Black: king e1→g1, castling)
 *   Last: e8=Q (Black: pawn e7→e8, promotes to queen)
 *   Last: Nf3+ (Black: knight g1→f3, check)
 */
function formatLastLine(san: string, detail: LastMoveDetail, advColor: string): string {
  const isCastling = san.startsWith("O-O");
  const isEnPassant = san.includes("e.p.");
  const isPromotion = detail.promotion != null;
  const isCapture = detail.captured != null;

  let line = `Last: ${san} (${advColor}: ${detail.piece} ${detail.from}→${detail.to}`;

  if (isCastling) {
    line += ", castling";
  } else {
    if (isCapture) {
      line += ` takes ${detail.captured}`;
      if (isEnPassant) line += " en passant";
    }
    if (isPromotion) {
      line += `, promotes to ${detail.promotion}`;
    }
    if (detail.isCheck) {
      line += ", check";
    }
  }

  line += ")";
  return line;
}

/**
 * Reset the history at the end of a turn, keeping only the system prompt.
 *
 * Each turn rebuilds a self-contained user message (fresh board + recent moves +
 * plan notes via {@link formatBoardMessage}), so nothing else needs to persist —
 * in particular no stale board diagram lingers in context.
 */
function pruneHistory(
  history: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): void {
  const system = history[0];
  history.length = 0;
  if (system) history.push(system);
}
