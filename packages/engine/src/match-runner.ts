import type { LlmProvider, LogEntry, MatchConfig, ToolDefinition } from "@agentarena/types";
import { MatchLogger } from "./match-logger.js";
import { McpManager } from "./mcp-manager.js";
import { createProvider } from "./providers/factory.js";

interface PlayerState {
  id: string;
  name: string;
  provider: ReturnType<typeof createProvider>;
  retries: number;
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
      const gameSystemPrompt = await this.getMcpSystemPrompt();

      // Resolve the game system prompt
      const systemPrompt =
        gameSystemPrompt ?? "You are playing a game. Use the available tools to make your moves.";

      // Build tool definitions for the LLMs
      const toolDefs: ToolDefinition[] = this.mcp.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: t.inputSchema as Record<string, unknown>,
        },
      }));

      // Give each player the system prompt once
      const histories: Array<Array<{ role: "system" | "user" | "assistant"; content: string }>> =
        this.players.map(() => {
          return [{ role: "system" as const, content: systemPrompt }];
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
        const state = await this.mcp.callTool("get_state", {});
        const stateStr = typeof state === "string" ? state : JSON.stringify(state, null, 2);
        history.push({ role: "user", content: `Turn ${turn}. Game state:\n${stateStr}` });

        // Also give the current player context about other players' moves
        if (turn > 1) {
          for (const other of this.players) {
            if (other.id !== player.id && other.provider) {
              // Other player has already moved — this is implicit from the game state
            }
          }
        }

        // Send to LLM
        const llmStart = performance.now();
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

        const latency = Math.round(performance.now() - llmStart);
        this.log.write({
          type: "llm.response",
          t: new Date().toISOString(),
          matchId: this.config.matchId,
          playerId: player.id,
          content: response.content,
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

                  return await this.endMatch(
                    "game_over",
                    (resultObj?.winner_id ?? resultObj?.winnerId) as string | undefined,
                  );
                }

                // Inject tool result into history for next turn
                history.push({
                  role: "assistant",
                  content: response.content,
                });
                history.push({
                  role: "user",
                  content: `Tool result: ${JSON.stringify(result)}`,
                });
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

  private async getMcpSystemPrompt(): Promise<string | undefined> {
    try {
      const tools = this.mcp.tools;
      if (tools.length === 0) return undefined;

      // Generic system prompt describing the available tools
      const toolDescriptions = tools
        .map((t) => `- ${t.name}: ${t.description ?? "no description"}`)
        .join("\n");

      return `You are playing a game. Use the available tools to make your moves.\n\nAvailable tools:\n${toolDescriptions}\n\nCall one tool per turn to make your move. The game state will be provided to you.`;
    } catch {
      return undefined;
    }
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
