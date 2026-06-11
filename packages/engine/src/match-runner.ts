import type {
  LlmProvider,
  LlmResponseEntry,
  LlmSendConfig,
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
  /** Per-player sampling settings (vendor-recommended). Undefined ⇒ provider default. */
  temperature: number | undefined;
  topP: number | undefined;
  /** Per-player reasoning effort cap for hybrid models. Undefined ⇒ model default. */
  reasoningEffort: LlmSendConfig["reasoningEffort"];
  /** Per-player verbosity (Anthropic/OpenRouter output_config.effort). Undefined ⇒ model default. */
  verbosity: LlmSendConfig["verbosity"];
  /** Max reasoning tokens; caps internal thinking so the tool call always fits. Undefined ⇒ uncapped. */
  reasoningBudget: LlmSendConfig["reasoningBudget"];
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
        temperature: p.temperature,
        topP: p.topP,
        reasoningEffort: p.reasoningEffort,
        verbosity: p.verbosity,
        reasoningBudget: p.reasoningBudget,
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

        // Pure-pull protocol: the arena does NOT hand the model the game state. The
        // model must call the state tool itself to observe the board, then act. The
        // agentic turn loop below keeps the SAME player until it plays a legal move,
        // so a read-then-move sequence costs no turn. We carry only the player's own
        // recent moves and plan notes (lightweight memory) so it keeps its thread.
        history.push({
          role: "user",
          content: formatTurnMessage(
            turn,
            this.config.stateToolName,
            player.lastMoves,
            player.notes,
          ),
        });

        // --- Turn loop: prompt this player until it makes an ACCEPTED move ---
        // A turn ends ONLY when the player plays a legal move. A read-only tool
        // (e.g. get_board) feeds its result back and the SAME player continues:
        // inspecting the board must never cost a turn, and must never hand the
        // move to the opponent — the game server applies moves by side-to-move,
        // so rotating after a non-move would let one model play BOTH colors. No
        // tool call, an illegal move, or a provider error all re-prompt the same
        // player; a hard action cap forfeits a player that never moves.
        const turnStart = performance.now();
        const maxTurnActions = this.config.limits.maxRetriesPerTurn * 4;

        let sent = await this.sendAndLog(player, history, toolDefs);
        if (!sent) {
          player.retries++;
          if (player.retries >= this.config.limits.maxRetriesPerTurn) {
            this.log.write({
              type: "forfeit",
              t: new Date().toISOString(),
              matchId: this.config.matchId,
              playerId: player.id,
              reason: `LLM error after ${player.retries} retries`,
            });
            return await this.endMatch("forfeit", this.getNextPlayer(currentPlayerIndex)?.id);
          }
          continue;
        }
        let { response, latencyMs: llmLatencyMs } = sent;

        let moveMade = false;
        let turnActions = 0;

        while (!moveMade) {
          // No tool call at all → no move produced (output truncated, or text only).
          if (response.toolCalls.length === 0) {
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
            history.push(assistantTurn(response.content));
            history.push({
              role: "user",
              content:
                "You did not call any tool. Complete your turn by calling make_move with a legal move.",
            });
            sent = await this.sendAndLog(player, history, toolDefs);
            if (!sent) break;
            ({ response, latencyMs: llmLatencyMs } = sent);
            continue;
          }

          // Hard safety cap: never loop forever on read-only tools.
          if (++turnActions > maxTurnActions) {
            this.log.write({
              type: "forfeit",
              t: new Date().toISOString(),
              matchId: this.config.matchId,
              playerId: player.id,
              reason: `No move after ${turnActions} tool calls in a single turn`,
            });
            return await this.endMatch("forfeit", this.getNextPlayer(currentPlayerIndex)?.id);
          }

          const tc = response.toolCalls[0];
          if (!tc) break; // unreachable: length checked above
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            args = {};
          }

          this.log.write({
            type: "tool.call",
            t: new Date().toISOString(),
            matchId: this.config.matchId,
            playerId: player.id,
            toolName: tc.function.name,
            args,
            attempt: turnActions,
          });

          let result: unknown;
          let mcpLatencyMs = 0;
          try {
            const mcpStart = performance.now();
            result = await this.mcp.callTool(tc.function.name, args);
            mcpLatencyMs = Math.round(performance.now() - mcpStart);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.write({
              type: "tool.error",
              t: new Date().toISOString(),
              matchId: this.config.matchId,
              playerId: player.id,
              toolName: tc.function.name,
              error: message,
              attempt: turnActions,
            });
            // A dead MCP transport (the game server process crashed) is an
            // infrastructure failure, not the player's fault: end the match with
            // no winner rather than forfeiting this player to its opponent.
            if (this.mcp.connected === false) {
              return await this.endMatch("mcp_crash", undefined);
            }
            player.retries++;
            if (player.retries >= this.config.limits.maxRetriesPerTurn) {
              this.log.write({
                type: "forfeit",
                t: new Date().toISOString(),
                matchId: this.config.matchId,
                playerId: player.id,
                reason: `Tool error after ${player.retries} retries: ${message}`,
              });
              return await this.endMatch("forfeit", this.getNextPlayer(currentPlayerIndex)?.id);
            }
            history.push(assistantTurn(response.content));
            history.push({
              role: "user",
              content: `Tool call error: ${message}. Respond with a corrected make_move.`,
            });
            sent = await this.sendAndLog(player, history, toolDefs);
            if (!sent) break;
            ({ response, latencyMs: llmLatencyMs } = sent);
            continue;
          }

          // Game over signalled by the MCP server.
          const resultObj = result as Record<string, unknown> | undefined;
          if (resultObj?.game_over || resultObj?.gameOver) {
            this.log.write({
              type: "game.over",
              t: new Date().toISOString(),
              matchId: this.config.matchId,
              playerId: player.id,
              result: resultObj,
            });
            history.push(assistantTurn(response.content));
            const rawWinnerId = (resultObj?.winner_id ?? resultObj?.winnerId) as string | undefined;
            return await this.endMatch("game_over", this.mapGameWinner(rawWinnerId));
          }

          const resultContent = extractTextContent(result);
          const resultJson = tryParseJson(resultContent);

          // Illegal move → the game server tracks the fault (and forfeits at 3
          // via game_over). Re-prompt the SAME player within this turn.
          if (resultJson?.accepted === false) {
            history.push(assistantTurn(response.content));
            history.push({
              role: "user",
              content: `Illegal move. Faults: ${String(resultJson.faults_total ?? "?")}/3. Try a different legal move.`,
            });
            sent = await this.sendAndLog(player, history, toolDefs);
            if (!sent) break;
            ({ response, latencyMs: llmLatencyMs } = sent);
            continue;
          }

          // Accepted move → the turn is complete.
          if (resultJson?.accepted === true || (resultJson?.san && resultJson?.piece_moved)) {
            this.log.write({
              type: "turn_metrics",
              t: new Date().toISOString(),
              matchId: this.config.matchId,
              playerId: player.id,
              llmLatencyMs,
              mcpLatencyMs,
              turnDurationMs: Math.round(performance.now() - turnStart),
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
              if (player.lastMoves.length > 3) player.lastMoves.shift();
            }

            // Remember the player's own reasoning (plan memory) for the next
            // few turns so it doesn't lose track of its intentions.
            const note = response.content.trim();
            if (note) {
              player.notes.push(note);
              if (player.notes.length > 3) player.notes.shift();
            }

            player.turnCount++;
            player.retries = 0;
            moveMade = true;
            break;
          }

          // Read-only tool (e.g. get_board): feed the result back and continue
          // the turn with the SAME player so it can now move. (The core fix.)
          history.push(assistantTurn(response.content));
          history.push({
            role: "user",
            content: `Tool result: ${resultContent}\nNow complete your turn by calling make_move.`,
          });
          sent = await this.sendAndLog(player, history, toolDefs);
          if (!sent) break;
          ({ response, latencyMs: llmLatencyMs } = sent);
        }

        // The loop only exits without a move when a re-prompt failed (provider
        // error mid-turn). Treat it as a strike: retry the SAME player next outer
        // iteration, never rotate.
        if (!moveMade) {
          player.retries++;
          if (player.retries >= this.config.limits.maxRetriesPerTurn) {
            this.log.write({
              type: "forfeit",
              t: new Date().toISOString(),
              matchId: this.config.matchId,
              playerId: player.id,
              reason: `Failed to produce a move after ${player.retries} attempts`,
            });
            return await this.endMatch("forfeit", this.getNextPlayer(currentPlayerIndex)?.id);
          }
          pruneHistory(history);
          continue;
        }

        // Prune so the next turn rebuilds a fresh, self-contained board message.
        pruneHistory(history);

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

  /**
   * Build the per-turn send config for a player: the shared token budget plus
   * any vendor-recommended sampling settings. Sampling fields are included only
   * when set, so an unconfigured player keeps the provider's own defaults.
   */
  private sendConfig(player: PlayerState): LlmSendConfig {
    const cfg: LlmSendConfig = {
      maxTokens: player.maxTokens ?? this.config.limits.maxTokensPerTurn,
    };
    if (player.temperature !== undefined) cfg.temperature = player.temperature;
    if (player.topP !== undefined) cfg.topP = player.topP;
    if (player.reasoningEffort !== undefined) cfg.reasoningEffort = player.reasoningEffort;
    if (player.verbosity !== undefined) cfg.verbosity = player.verbosity;
    if (player.reasoningBudget !== undefined) cfg.reasoningBudget = player.reasoningBudget;
    return cfg;
  }

  /**
   * Send the current history to a player's LLM, logging the request and response
   * and accumulating token + latency stats. Returns the response with its
   * latency, or null when the provider call failed (the caller decides whether
   * to retry or forfeit). Every LLM call in a turn — the first and every
   * re-prompt — goes through here, so all of them are logged and counted.
   */
  private async sendAndLog(
    player: PlayerState,
    history: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    toolDefs: ToolDefinition[],
  ): Promise<{ response: Awaited<ReturnType<LlmProvider["send"]>>; latencyMs: number } | null> {
    const start = performance.now();
    this.log.write({
      type: "llm.sent",
      t: new Date().toISOString(),
      matchId: this.config.matchId,
      playerId: player.id,
      messageCount: history.length,
    });

    let response: Awaited<ReturnType<LlmProvider["send"]>>;
    try {
      response = await player.provider.send(history, toolDefs, this.sendConfig(player));
    } catch (err) {
      this.log.write({
        type: "llm.error",
        t: new Date().toISOString(),
        matchId: this.config.matchId,
        playerId: player.id,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    const latencyMs = Math.round(performance.now() - start);
    const responseEntry: LlmResponseEntry = {
      type: "llm.response",
      t: new Date().toISOString(),
      matchId: this.config.matchId,
      playerId: player.id,
      content: response.content,
      tokensInput: response.tokensInput,
      tokensOutput: response.tokensOutput,
      finishReason: response.finishReason,
      latencyMs,
    };
    // Reasoning trace is logged for post-mortem only — it is NOT added to `history`,
    // so it never re-enters the model's context (keeps cost/latency bounded).
    if (response.reasoning) responseEntry.reasoning = response.reasoning;
    this.log.write(responseEntry);

    player.totalLlmLatencyMs += latencyMs;
    player.totalTokensInput += response.tokensInput;
    player.totalTokensOutput += response.tokensOutput;
    return { response, latencyMs };
  }

  private getNextPlayer(currentIndex: number): PlayerState | undefined {
    return this.players[(currentIndex + 1) % this.players.length];
  }

  /**
   * Map game-server color IDs ("white"/"black") to actual player IDs.
   * In a 2-player match, player[0] = white, player[1] = black.
   */
  private mapGameWinner(rawWinnerId?: string): string | undefined {
    // A drawn game (stalemate / 50-move) sends winner_id: null — normalize the absence
    // of a winner to undefined so match.end omits winnerId rather than writing null.
    if (!rawWinnerId) return undefined;
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
  "Each turn, first call the state tool to observe the game, then call the action tool.\n" +
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
 * Build an assistant history turn with guaranteed non-empty content.
 *
 * A model may answer with only a tool call and no text — Anthropic then rejects
 * a replayed empty assistant message ("text content blocks must be non-empty").
 * Substitute a placeholder so the within-turn history stays valid for every provider.
 */
function assistantTurn(content: string): { role: "assistant"; content: string } {
  return { role: "assistant", content: content.trim() || "(tool call)" };
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
 * Build the per-turn user message for the pure-pull protocol.
 *
 * The arena does not embed the game state — the model must call `stateTool` itself
 * to observe the board, then take its action. We carry only the player's own recent
 * moves (factual memory) and recent reasoning notes (plan memory) so the agent keeps
 * track of its intentions across turns.
 */
function formatTurnMessage(
  turn: number,
  stateTool: string,
  recentMoves: LastMoveDetail[],
  recentNotes: string[],
): string {
  let msg = `Turn ${turn}. It is your turn.\n`;
  msg += `Call ${stateTool} to observe the current state, then take your action.`;

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
 * Reset the history at the end of a turn, keeping only the system prompt.
 *
 * Each turn rebuilds a self-contained user message (a prompt to observe the state
 * via the state tool, plus the player's recent moves and plan notes through
 * {@link formatTurnMessage}), so nothing else needs to persist.
 */
function pruneHistory(
  history: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): void {
  const system = history[0];
  history.length = 0;
  if (system) history.push(system);
}
