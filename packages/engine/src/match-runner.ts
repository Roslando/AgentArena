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

interface LastActionDetail {
  /** Short human label of the accepted action, for the agent's own short-term memory. */
  summary: string;
}

/** One turn of conversation history sent to a provider. */
type HistoryMsg = { role: "system" | "user" | "assistant"; content: string };

/** A mutable tool-call budget shared across an agentic episode (the safety net). */
interface IterationBudget {
  remaining: number;
}

/**
 * The outcome of running a single player until it takes ONE accepted action (or the
 * episode ends). The mode loops interpret this to decide rotation / match end.
 */
type ActionStep =
  | { kind: "action"; summary: string; note: string }
  | { kind: "game_over"; result: Record<string, unknown> }
  | { kind: "broken"; reason: string }
  | { kind: "mcp_crash" };

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
  turnCount: number;
  totalLlmLatencyMs: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  /** Every tool call this player issued (state reads + actions). */
  toolCalls: number;
  /** The player's own failed tool calls (rejected actions + tool errors) — the error signal. */
  invalidActions: number;
  /** Responses cut off at the token budget before acting — a budget signal, NOT an error. */
  truncations: number;
  /** Opaque task stats from this player's own game_over (independent mode). */
  taskStats?: Record<string, unknown>;
  lastActions: LastActionDetail[];
  /**
   * The agent's self-curated working memory. It rewrites this each turn (carry forward
   * what it still needs, drop the stale) — the only thing besides lastActions that
   * survives a turn, since raw tool outputs are cleared. Structured note-taking, agent-owned.
   */
  memory: string;
}

/**
 * Orchestrates a match between two or more LLM players on an MCP task server.
 *
 * The runner owns the match loop and is agnostic of task rules — it only relays tool
 * calls and errors between the LLM and the MCP server. It supports three orchestration
 * modes (see {@link MatchConfig.orchestrationMode}):
 *   - turn-by-turn: agents alternate on one shared task;
 *   - concurrent: agents act in the same round, in parallel, on one shared task;
 *   - independent: each agent runs the whole task alone on its own isolated MCP.
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
        turnCount: 0,
        totalLlmLatencyMs: 0,
        totalTokensInput: 0,
        totalTokensOutput: 0,
        toolCalls: 0,
        invalidActions: 0,
        truncations: 0,
        lastActions: [],
        memory: "",
      });
    }
  }

  /** Expose the log instance for external writes (e.g., mcp-manager). */
  get logger(): MatchLogger {
    return this.log;
  }

  /**
   * Run the full match to completion. Dispatches on the configured orchestration mode;
   * each mode owns its own MCP connection lifecycle.
   */
  async run(): Promise<{ winnerId?: string; reason: string }> {
    this.startTime = Date.now();
    this.abortController = new AbortController();

    this.log.write({
      type: "match.start",
      t: new Date().toISOString(),
      matchId: this.config.matchId,
      ...(this.config.game ? { game: this.config.game } : {}),
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
      if (this.config.orchestrationMode === "independent") {
        return await this.runIndependent();
      }
      return await this.runShared(this.config.orchestrationMode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.write({
        type: "mcp.error",
        t: new Date().toISOString(),
        matchId: this.config.matchId,
        message,
      });
      return await this.endMatch("error", undefined);
    }
  }

  /**
   * Shared-state modes (turn-by-turn, concurrent): connect ONE MCP server, discover its
   * tools, then run the chosen loop. Owns the connection so it always disconnects.
   */
  private async runShared(
    mode: "turn-by-turn" | "concurrent",
  ): Promise<{ winnerId?: string; reason: string }> {
    try {
      await this.mcp.connect();
      const { toolDefs, actionToolList } = this.discoverTools(this.mcp);
      const mcpPrompt = await this.mcp.getSystemPrompt();
      const histories = this.players.map((p) => this.buildHistory(p, mcpPrompt));
      return mode === "concurrent"
        ? await this.runConcurrent(toolDefs, actionToolList, histories)
        : await this.runTurnByTurn(toolDefs, actionToolList, histories);
    } finally {
      await this.mcp.disconnect();
    }
  }

  /**
   * Turn-by-turn: agents alternate on one shared task. A player keeps the floor —
   * observing the state, retrying after an error — until it takes ONE accepted action,
   * then the next player plays. Observing the state never costs a turn and never hands
   * the move to the opponent (the server applies actions by side-to-move).
   */
  private async runTurnByTurn(
    toolDefs: ToolDefinition[],
    actionToolList: string,
    histories: HistoryMsg[][],
  ): Promise<{ winnerId?: string; reason: string }> {
    let currentPlayerIndex = 0;
    let turn = 0;

    while (!this.abortController.signal.aborted) {
      if (this.timedOut()) return await this.endMatch("timeout", undefined);

      const player = this.players[currentPlayerIndex];
      const history = histories[currentPlayerIndex];
      if (!player || !history) break;

      turn++;
      history.push({
        role: "user",
        content: formatTurnMessage(
          turn,
          this.config.stateToolName,
          player.lastActions,
          player.memory,
        ),
      });

      const budget: IterationBudget = { remaining: this.config.limits.maxIterations };
      const step = await this.runOneAction(
        player,
        history,
        toolDefs,
        this.mcp,
        actionToolList,
        budget,
        turn,
      );

      if (step.kind === "mcp_crash") return await this.endMatch("mcp_crash", undefined);
      if (step.kind === "broken") {
        this.logForfeit(player.id, step.reason);
        return await this.endMatch("forfeit", this.getNextPlayer(currentPlayerIndex)?.id);
      }
      if (step.kind === "game_over") {
        const rawWinnerId = (step.result.winner_id ?? step.result.winnerId) as string | undefined;
        return await this.endMatch(
          "game_over",
          this.mapGameWinner(rawWinnerId),
          extractTaskStats(step.result),
        );
      }

      // Accepted action → record memory, rotate to the next player.
      this.remember(player, step.summary, step.note);
      player.turnCount++;
      pruneHistory(history);
      currentPlayerIndex = (currentPlayerIndex + 1) % this.players.length;
    }

    return await this.endMatch("unknown", undefined);
  }

  /**
   * Concurrent: every agent acts in the SAME round, in parallel, on one shared task.
   * The first agent to signal game_over ends the match; if every agent is stuck in the
   * same round, the match ends with no winner.
   */
  private async runConcurrent(
    toolDefs: ToolDefinition[],
    actionToolList: string,
    histories: HistoryMsg[][],
  ): Promise<{ winnerId?: string; reason: string }> {
    let round = 0;

    while (!this.abortController.signal.aborted) {
      if (this.timedOut()) return await this.endMatch("timeout", undefined);

      round++;
      this.players.forEach((player, i) => {
        const h = histories[i];
        if (h) {
          h.push({
            role: "user",
            content: formatTurnMessage(
              round,
              this.config.stateToolName,
              player.lastActions,
              player.memory,
            ),
          });
        }
      });

      const steps = await Promise.all(
        this.players.map((player, i) => {
          const budget: IterationBudget = { remaining: this.config.limits.maxIterations };
          return this.runOneAction(
            player,
            histories[i] as HistoryMsg[],
            toolDefs,
            this.mcp,
            actionToolList,
            budget,
            round,
          );
        }),
      );

      // A crash or a game_over from any agent ends the round immediately.
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (step?.kind === "mcp_crash") return await this.endMatch("mcp_crash", undefined);
        if (step?.kind === "game_over") {
          const rawWinnerId = (step.result.winner_id ?? step.result.winnerId) as string | undefined;
          return await this.endMatch(
            "game_over",
            this.mapGameWinner(rawWinnerId),
            extractTaskStats(step.result),
          );
        }
      }

      // No one could progress this round → the match is stuck.
      if (steps.every((s) => s.kind === "broken")) {
        steps.forEach((s, i) => {
          if (s.kind === "broken") this.logForfeit(this.players[i]?.id ?? "", s.reason);
        });
        return await this.endMatch("forfeit", undefined);
      }

      // Record each agent's accepted action and reset its history for the next round.
      this.players.forEach((player, i) => {
        const step = steps[i];
        if (step?.kind === "action") {
          this.remember(player, step.summary, step.note);
          player.turnCount++;
        }
        const h = histories[i];
        if (h) pruneHistory(h);
      });
    }

    return await this.endMatch("unknown", undefined);
  }

  /**
   * Independent: every agent runs the WHOLE task alone on its OWN isolated MCP instance,
   * all in parallel. There is no head-to-head winner — unless exactly one agent solves
   * the task, the report ranks the models by composite score.
   */
  private async runIndependent(): Promise<{ winnerId?: string; reason: string }> {
    const outcomes = await Promise.all(this.players.map((p) => this.runIndependentEpisode(p)));
    const solvers = this.players.filter((_, i) => outcomes[i] === "won");
    const winnerId = solvers.length === 1 ? solvers[0]?.id : undefined;
    return await this.endMatch("game_over", winnerId);
  }

  /**
   * Run one agent through a complete solo task on a fresh MCP instance. The whole run
   * shares a single iteration budget (the safety net spans the entire episode, not one
   * action). Returns whether this agent solved, merely completed, or got stuck.
   */
  private async runIndependentEpisode(player: PlayerState): Promise<"won" | "completed" | "stuck"> {
    const mcp = new McpManager(this.config.mcpServer, this.log, this.config.matchId);
    try {
      await mcp.connect();
      const { toolDefs, actionToolList } = this.discoverTools(mcp);
      const mcpPrompt = await mcp.getSystemPrompt();
      const history = this.buildHistory(player, mcpPrompt);
      const budget: IterationBudget = { remaining: this.config.limits.maxIterations };
      let turn = 0;

      while (!this.abortController.signal.aborted) {
        if (this.timedOut()) return "stuck";
        turn++;
        history.push({
          role: "user",
          content: formatTurnMessage(
            turn,
            this.config.stateToolName,
            player.lastActions,
            player.memory,
          ),
        });

        const step = await this.runOneAction(
          player,
          history,
          toolDefs,
          mcp,
          actionToolList,
          budget,
          turn,
        );

        if (step.kind === "mcp_crash") return "stuck";
        if (step.kind === "broken") {
          this.logForfeit(player.id, step.reason);
          return "stuck";
        }
        if (step.kind === "game_over") {
          // Attach this agent's own task stats (each independent episode has its own
          // game_over) so the report can show per-model task metrics.
          const stats = extractTaskStats(step.result);
          if (stats) player.taskStats = stats;
          return episodeWon(step.result, player.id) ? "won" : "completed";
        }

        this.remember(player, step.summary, step.note);
        player.turnCount++;
        pruneHistory(history);
      }
      return "stuck";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.write({
        type: "mcp.error",
        t: new Date().toISOString(),
        matchId: this.config.matchId,
        message,
      });
      return "stuck";
    } finally {
      await mcp.disconnect();
    }
  }

  /**
   * Prompt ONE player until it takes an accepted action (the unit of progress), or the
   * episode terminates. A read-only tool feeds its result back and the SAME player
   * continues — observing the state never ends the unit. Errors (rejected actions, tool
   * exceptions, no-tool replies) re-prompt the same player with the error message, and
   * are governed by the circuit breaker, NOT a hard retry cap: only consecutive errors
   * with no success in between count, so a model that recovers is never cut short.
   */
  private async runOneAction(
    player: PlayerState,
    history: HistoryMsg[],
    toolDefs: ToolDefinition[],
    mcp: McpManager,
    actionToolList: string,
    budget: IterationBudget,
    turnNumber: number,
  ): Promise<ActionStep> {
    const turnStart = performance.now();
    const maxConsecutive = this.config.limits.maxConsecutiveErrors;
    let consecutiveErrors = 0;

    let sent = await this.sendAndLog(player, history, toolDefs);

    while (true) {
      // Provider call failed (already logged as llm.error) — a failure with no action.
      if (!sent) {
        consecutiveErrors++;
        if (consecutiveErrors >= maxConsecutive) {
          return { kind: "broken", reason: `provider error ${consecutiveErrors}× in a row` };
        }
        sent = await this.sendAndLog(player, history, toolDefs);
        continue;
      }
      const { response, latencyMs: llmLatencyMs } = sent;

      // No tool call at all → no action produced. Two very different causes:
      //  - TRUNCATION: the output was cut off at the token budget before a tool call
      //    could be emitted (finishReason length/max_tokens). The model did NOT fail —
      //    it ran out of room. We count it separately (a budget signal, NOT the error
      //    rate), and the re-prompt asks it to be concise rather than scolding it.
      //  - a genuine stall (text-only reply, refusal): the usual non-action.
      // Either way we re-prompt the SAME player (never hand the turn over); the circuit
      // breaker is only a loop guard so a fundamentally-too-small budget can't burn
      // tokens forever, and its reason names the real cause.
      if (response.toolCalls.length === 0) {
        const truncated = isTruncated(response.finishReason);
        if (truncated) player.truncations++;
        consecutiveErrors++;
        history.push(assistantTurn(response.content));
        if (consecutiveErrors >= maxConsecutive) {
          return {
            kind: "broken",
            reason: truncated
              ? `output truncated at the token limit ${consecutiveErrors}× in a row — raise maxTokens (or lower reasoning/verbosity) for this model`
              : `no tool call ${consecutiveErrors}× in a row (finishReason: ${response.finishReason ?? "unknown"})`,
          };
        }
        history.push({
          role: "user",
          content: truncated
            ? `Your previous response was cut off at the token limit before you could act. Be concise — skip long explanations and call your action tool (${actionToolList}) directly now.`
            : nudge(
                `You did not call any tool. Call one of the action tools (${actionToolList}) to complete your turn.`,
                consecutiveErrors,
              ),
        });
        sent = await this.sendAndLog(player, history, toolDefs);
        continue;
      }

      // Safety net: never loop forever on tool calls that make no progress.
      if (budget.remaining <= 0) {
        return {
          kind: "broken",
          reason: `iteration budget exhausted (${this.config.limits.maxIterations} tool calls)`,
        };
      }
      budget.remaining--;
      const attempt = this.config.limits.maxIterations - budget.remaining;

      const tc = response.toolCalls[0];
      if (!tc) return { kind: "broken", reason: "empty tool call" }; // unreachable
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
        attempt,
      });
      player.toolCalls++;

      let result: unknown;
      let mcpLatencyMs = 0;
      try {
        // A slow tool is legitimate — AgentArena evaluates agents against arbitrary
        // MCP servers, some of which take real time. We AWAIT it fully (never time it
        // out, never hand the turn over): tool latency is the task's, not the model's,
        // and is measured separately as mcpLatencyMs so it never pollutes the model's
        // reflection metric. Only a dead transport (crash) below ends the run.
        const mcpStart = performance.now();
        result = await mcp.callTool(tc.function.name, args);
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
          attempt,
        });
        // A dead MCP transport (the task server process crashed) is an infrastructure
        // failure, not the player's fault: end with no winner rather than blaming it.
        if (mcp.connected === false) return { kind: "mcp_crash" };
        // A tool that threw is a failed call — part of the error signal.
        player.invalidActions++;
        consecutiveErrors++;
        history.push(assistantTurn(response.content));
        if (consecutiveErrors >= maxConsecutive) {
          return {
            kind: "broken",
            reason: `tool error ${consecutiveErrors}× in a row: ${message}`,
          };
        }
        history.push({
          role: "user",
          content: nudge(
            `Tool call error: ${message}. Respond with a corrected action.`,
            consecutiveErrors,
          ),
        });
        sent = await this.sendAndLog(player, history, toolDefs);
        continue;
      }

      // Task ended, signalled by the MCP server.
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
        return { kind: "game_over", result: resultObj };
      }

      const resultContent = extractTextContent(result);
      const resultJson = tryParseJson(resultContent);

      // Rejected action (`accepted: false`) → the player's own failure. Count it in the
      // error signal and re-prompt the SAME player with the rejection reason.
      if (resultJson?.accepted === false) {
        player.invalidActions++;
        consecutiveErrors++;
        const reason = (resultJson.message ?? resultJson.reason) as string | undefined;
        history.push(assistantTurn(response.content));
        if (consecutiveErrors >= maxConsecutive) {
          return {
            kind: "broken",
            reason: `invalid action ${consecutiveErrors}× in a row${reason ? `: ${reason}` : ""}`,
          };
        }
        history.push({
          role: "user",
          content: nudge(
            `Invalid action${reason ? `: ${reason}` : ""}. Try a different valid action.`,
            consecutiveErrors,
          ),
        });
        sent = await this.sendAndLog(player, history, toolDefs);
        continue;
      }

      // Accepted action → the unit is complete. `accepted: true` is the contract;
      // `san && piece_moved` is a backward-compat fallback for chess.
      if (resultJson?.accepted === true || (resultJson?.san && resultJson?.piece_moved)) {
        this.log.write({
          type: "turn_metrics",
          t: new Date().toISOString(),
          matchId: this.config.matchId,
          playerId: player.id,
          llmLatencyMs,
          mcpLatencyMs,
          turnDurationMs: Math.round(performance.now() - turnStart),
          turnNumber,
        });
        // A short, task-agnostic label of the action for the agent's memory: the MCP's
        // own `summary`, else chess SAN, else the tool name.
        const summary =
          typeof resultJson?.summary === "string"
            ? resultJson.summary
            : typeof resultJson?.san === "string"
              ? String(resultJson.san)
              : tc.function.name;
        return { kind: "action", summary, note: response.content.trim() };
      }

      // Read-only tool (e.g. get_board): a success — reset the error streak, feed the
      // result back, and continue the unit with the SAME player so it can now act.
      consecutiveErrors = 0;
      history.push(assistantTurn(response.content));
      history.push({
        role: "user",
        content: `Tool result: ${resultContent}\nNow complete your turn by calling an action tool (${actionToolList}).`,
      });
      sent = await this.sendAndLog(player, history, toolDefs);
    }
  }

  /**
   * Validate the MCP tool surface and build the tool definitions for the LLMs.
   * Throws (fail fast, before spending tokens) if the state tool or an action tool is
   * missing. Returns the tool defs and a comma-joined list of action-tool names so the
   * re-prompts can stay generic (a research MCP has `search`, not `make_move`).
   */
  private discoverTools(mcp: McpManager): { toolDefs: ToolDefinition[]; actionToolList: string } {
    const toolNames = mcp.tools.map((t) => t.name);
    if (!toolNames.includes(this.config.stateToolName)) {
      throw new Error(
        `MCP server exposes no "${this.config.stateToolName}" tool (stateToolName). Available: ${toolNames.join(", ") || "none"}`,
      );
    }
    if (toolNames.length < 2) {
      throw new Error(`MCP server exposes no action tool besides "${this.config.stateToolName}".`);
    }
    const actionTools = toolNames.filter((n) => n !== this.config.stateToolName);
    const toolDefs: ToolDefinition[] = mcp.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));
    return { toolDefs, actionToolList: actionTools.join(", ") };
  }

  /**
   * Build a player's initial history (just the system prompt) — 3-level fallback:
   * 1. configPlayer.systemPrompt (explicit override) 2. mcpPrompt (task server prompt)
   * 3. DEFAULT_SYSTEM_PROMPT (generic global fallback).
   */
  private buildHistory(player: PlayerState, mcpPrompt: string | null): HistoryMsg[] {
    const configPlayer = this.config.players.find((p) => p.id === player.id);
    const prompt = configPlayer?.systemPrompt ?? mcpPrompt ?? DEFAULT_SYSTEM_PROMPT;
    return [{ role: "system", content: prompt }];
  }

  /** True once the optional wall-clock cap has elapsed (no cap ⇒ never). */
  private timedOut(): boolean {
    return (
      this.config.limits.maxDurationMs !== undefined &&
      Date.now() - this.startTime > this.config.limits.maxDurationMs
    );
  }

  /** Carry the player's accepted action (factual log) and its rewritten memory forward. */
  private remember(player: PlayerState, summary: string, note: string): void {
    player.lastActions.push({ summary });
    if (player.lastActions.length > 3) player.lastActions.shift();
    // The agent rewrites its whole working memory each turn; an empty message (a tool-only
    // response with no text) leaves the previous memory intact rather than wiping it.
    if (note) player.memory = note;
  }

  /** Log that a player could not continue (circuit breaker / iteration budget). */
  private logForfeit(playerId: string, reason: string): void {
    this.log.write({
      type: "forfeit",
      t: new Date().toISOString(),
      matchId: this.config.matchId,
      playerId,
      reason,
    });
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
    history: HistoryMsg[],
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
   * Map task-server color IDs ("white"/"black") to actual player IDs.
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
    taskStats?: Record<string, unknown>,
  ): Promise<{ winnerId?: string; reason: string }> {
    // Write per-player aggregated stats before the final match.end entry
    this.log.write({
      type: "match.summary",
      t: new Date().toISOString(),
      matchId: this.config.matchId,
      matchDurationMs: Date.now() - this.startTime,
      // Opaque task stats relayed from the MCP's game_over, never interpreted here.
      ...(taskStats ? { taskStats } : {}),
      players: this.players.map((p) => ({
        playerId: p.id,
        turns: p.turnCount,
        totalLlmLatencyMs: p.totalLlmLatencyMs,
        avgLlmLatencyMs: p.turnCount > 0 ? Math.round(p.totalLlmLatencyMs / p.turnCount) : 0,
        totalTokensInput: p.totalTokensInput,
        totalTokensOutput: p.totalTokensOutput,
        totalTokens: p.totalTokensInput + p.totalTokensOutput,
        toolCalls: p.toolCalls,
        invalidActions: p.invalidActions,
        truncations: p.truncations,
        ...(p.taskStats ? { taskStats: p.taskStats } : {}),
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
  "You are an AI agent acting on a task you can only affect through tools.\n" +
  "Each turn: first call the state tool to observe the current state, then take your action " +
  "with an action tool. Raw tool outputs are cleared after your turn — they will NOT be in " +
  "your context next turn.\n" +
  "Across turns you carry ONE working memory that you rewrite yourself. Each turn you are shown " +
  "your current memory; in the message where you act, write your UPDATED memory — reformulate " +
  "it from the previous one: keep the facts, plan, and what you've already tried that you'll " +
  "still need, sharpen them, and drop whatever is now stale. Keep it concise (it is scarce " +
  "working memory, not a transcript); structure it however helps you. If something will matter " +
  "later, it survives ONLY if you put it in your memory, in your own words.";

/**
 * Whether an independent-mode episode's game_over result means THIS agent solved the
 * task. Task-agnostic: an explicit success flag, or a winner field naming this agent.
 * A winner-less completion is "completed" (not "won"), so the report falls back to the
 * composite score rather than crowning anyone.
 */
function episodeWon(result: Record<string, unknown>, playerId: string): boolean {
  if (result.won === true || result.success === true) return true;
  const winner = result.winner_id ?? result.winnerId ?? result.winner;
  return typeof winner === "string" && winner === playerId;
}

/**
 * Pull the MCP's optional task-specific final stats out of a game_over result.
 * Convention: the server puts them under a `stats` object (so they are unambiguous,
 * never confused with control fields like `game_over`/`winner_id`). Relayed verbatim,
 * never interpreted — any task surfaces its own metrics with zero engine/config change.
 */
function extractTaskStats(result: Record<string, unknown>): Record<string, unknown> | undefined {
  const stats = result.stats;
  if (stats && typeof stats === "object" && !Array.isArray(stats)) {
    return stats as Record<string, unknown>;
  }
  return undefined;
}

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
 * Whether a response was cut off at the token budget (so it produced no tool call
 * because it ran out of room, NOT because the model stalled). Normalizes the finish
 * reason across providers: OpenAI/OpenRouter/Ollama "length", Anthropic "max_tokens",
 * Google "MAX_TOKENS".
 */
function isTruncated(finishReason: string | undefined): boolean {
  if (!finishReason) return false;
  const r = finishReason.toLowerCase();
  return r === "length" || r === "max_tokens" || r === "maxtokens";
}

/**
 * Add a recovery nudge once a player has failed repeatedly in a row. This is harness
 * feedback (change your approach), never a task hint — it helps the model break out of
 * a loop without limiting how far we observe its performance.
 */
function nudge(base: string, consecutiveErrors: number): string {
  if (consecutiveErrors >= 2) {
    return `${base}\n\nNote: you have failed ${consecutiveErrors} times in a row. Change your approach — re-read the state and use a different tool or arguments.`;
  }
  return base;
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
 * The arena does not embed the task state — the model must call `stateTool` itself
 * to observe it, then take its action. Across turns the agent carries only a factual
 * log of its recent accepted actions and its OWN self-curated working memory, which it
 * rewrites each turn — so it must actively keep forward what it will still need.
 */
function formatTurnMessage(
  turn: number,
  stateTool: string,
  recentActions: LastActionDetail[],
  memory: string,
): string {
  let msg = `Turn ${turn}. It is your turn.\n`;
  msg += `Call ${stateTool} to observe the current state, then take your action.`;

  if (recentActions.length > 0) {
    msg += `\n\nYour recent actions: ${recentActions.map((a) => a.summary).join(", ")}.`;
  }
  msg += memory
    ? `\n\nYour working memory (rewrite it when you act — keep what you'll still need, drop the stale):\n${memory}`
    : "\n\nYou have no working memory yet — start one in the message where you act.";

  return msg;
}

/**
 * Reset the history at the end of a turn, keeping only the system prompt.
 *
 * Each turn rebuilds a self-contained user message (a prompt to observe the state
 * via the state tool, plus the player's recent actions and self-curated working memory
 * through {@link formatTurnMessage}), so nothing else needs to persist.
 */
function pruneHistory(history: HistoryMsg[]): void {
  const system = history[0];
  history.length = 0;
  if (system) history.push(system);
}
