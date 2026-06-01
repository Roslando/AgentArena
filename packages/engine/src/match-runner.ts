import type { LlmProvider, LogEntry, MatchConfig, ToolDefinition } from "@agentarena/types";
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
  retries: number;
  totalThinkingTimeMs: number;
  lastMoves: LastMoveDetail[];
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

  constructor(private readonly config: MatchConfig) {
    this.log = new MatchLogger(config.matchId);
    this.mcp = new McpManager(config.mcpServer, this.log, config.matchId);

    for (const p of config.players) {
      this.players.push({
        id: p.id,
        name: p.name,
        provider: createProvider(p.id, p.provider),
        retries: 0,
        totalThinkingTimeMs: 0,
        lastMoves: [],
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
    });

    try {
      await this.mcp.connect();

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
        // Check global timer
        if (Date.now() - this.startTime > this.config.limits.maxDurationMs) {
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

        // Format minimal user message (Change 4)
        const turnStartIndex = history.length;
        if (boardJson) {
          const formatted = formatBoardMessage(turn, boardJson, player.lastMoves.at(-1) ?? null);
          history.push({ role: "user", content: formatted });
        } else {
          // Fallback: use raw state string
          history.push({ role: "user", content: `Turn ${turn}. Game state:\n${stateContent}` });
        }

        // Send to LLM (Change 2: start thinking timer)
        const turnStartTime = Date.now();
        this.log.write({
          type: "llm.sent",
          t: new Date().toISOString(),
          matchId: this.config.matchId,
          playerId: player.id,
          messageCount: history.length,
          tokensInput: 0,
        });

        let response: Awaited<ReturnType<LlmProvider["send"]>>;
        try {
          response = await player.provider.send(history, toolDefs, {
            maxTokens: this.config.limits.maxTokensPerTurn,
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

        const latency = Math.round(performance.now() - turnStartTime);
        this.log.write({
          type: "llm.response",
          t: new Date().toISOString(),
          matchId: this.config.matchId,
          playerId: player.id,
          content: response.content, // Change 6: pensée loggée
          tokensInput: response.tokensInput,
          tokensOutput: response.tokensOutput,
          finishReason: response.finishReason,
          latencyMs: latency,
        });

        // Execute tool calls
        if (response.toolCalls.length > 0) {
          for (const tc of response.toolCalls) {
            const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
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
                const result = await this.mcp.callTool(tc.function.name, args);

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

                  const rawWinnerId = (resultObj?.winner_id ?? resultObj?.winnerId) as string | undefined;
                  return await this.endMatch(
                    "game_over",
                    this.mapGameWinner(rawWinnerId),
                  );
                }

                // Change 2: calculate thinking time
                const turnEndTime = Date.now();
                const thinkingTimeMs = turnEndTime - turnStartTime;
                player.totalThinkingTimeMs += thinkingTimeMs;

                this.log.write({
                  type: "turn_metrics",
                  t: new Date().toISOString(),
                  matchId: this.config.matchId,
                  playerId: player.id,
                  thinkingTimeMs,
                  totalThinkingTimeMs: player.totalThinkingTimeMs,
                  turnNumber: turn,
                });

                // Track last move details for context pruning (Change 3)
                const resultContent = extractTextContent(result);
                const resultJson = tryParseJson(resultContent);
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

                // Inject tool result into history for next turn
                history.push({
                  role: "assistant",
                  content: response.content,
                });
                history.push({
                  role: "user",
                  content: `Tool result: ${resultContent}`,
                });

                // Change 3: prune history — keep system + last 3 SANs + current turn
                pruneHistory(history, player.lastMoves, turnStartIndex);

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
                    maxTokens: this.config.limits.maxTokensPerTurn,
                  });
                } catch {
                  break;
                }
              }
            }
          }
        } else {
          // Text-only response
          history.push({
            role: "assistant",
            content: response.content,
          });
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
  "One sentence of reasoning, then the tool call. No lists. No JSON. No long explanations.";

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
 * Format a minimal board message from the MCP get_board JSON response (Change 4).
 */
function formatBoardMessage(
  turn: number,
  board: Record<string, unknown>,
  lastOpponentMove: LastMoveDetail | null,
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
    line += `, castling`;
  } else {
    if (isCapture) {
      line += ` takes ${detail.captured}`;
      if (isEnPassant) line += ` en passant`;
    }
    if (isPromotion) {
      line += `, promotes to ${detail.promotion}`;
    }
    if (detail.isCheck) {
      line += `, check`;
    }
  }

  line += `)`;
  return line;
}

/**
 * Prune LLM history (Change 3):
 * - Keep system prompt
 * - Keep last 3 SAN descriptions from previous turns
 * - Keep current turn messages (from turnStartIndex onward)
 */
function pruneHistory(
  history: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  lastMoves: LastMoveDetail[],
  turnStartIndex: number,
): void {
  const system = history[0];
  const currentTurn = history.slice(turnStartIndex);

  // Build SAN description messages from the last N moves
  const sanMessages = lastMoves.map((m) => {
    const capture = m.captured ? ` takes ${m.captured}` : "";
    const check = m.isCheck ? `, check` : "";
    return {
      role: "user" as const,
      content: `Last move: ${m.san} (${m.piece} ${m.from}→${m.to}${capture}${check})`,
    };
  });

  history.length = 0;
  if (system) history.push(system);
  history.push(...sanMessages, ...currentTurn);
}
