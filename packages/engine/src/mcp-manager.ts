import type { LogEntry, McpServerConfig, McpTool } from "@agentarena/types";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { MatchLogger } from "./match-logger.js";

/**
 * Manages the lifecycle of an MCP game server connection.
 *
 * Connects, discovers tools, calls tools, and handles reconnection.
 */
export class McpManager {
  private client: Client;
  private transport?: StdioClientTransport;
  private _tools: McpTool[] = [];

  constructor(
    private readonly config: McpServerConfig,
    private readonly log: MatchLogger,
    private readonly matchId: string,
  ) {
    this.client = new Client({ name: "agentarena-engine", version: "0.1.0" }, { capabilities: {} });
  }

  get tools(): readonly McpTool[] {
    return this._tools;
  }

  /**
   * Connect to the MCP server and discover available tools.
   */
  async connect(): Promise<void> {
    this.log.write({
      type: "mcp.connecting",
      t: new Date().toISOString(),
      matchId: this.matchId,
      transport: this.config.transport,
    });

    if (this.config.transport === "stdio") {
      const params: { command: string; args: string[]; env?: Record<string, string> } = {
        command: this.config.command,
        args: this.config.args,
      };
      if (this.config.env) params.env = this.config.env;
      this.transport = new StdioClientTransport(params);
    } else {
      throw new Error("SSE transport not yet implemented");
    }

    this.client = new Client({ name: "agentarena-engine", version: "0.1.0" }, { capabilities: {} });

    await this.client.connect(this.transport);

    // Discover tools
    const result = await this.client.listTools();
    this._tools = result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));

    this.log.write({
      type: "mcp.connected",
      t: new Date().toISOString(),
      matchId: this.matchId,
      tools: this._tools.map((t) => t.name),
    });
  }

  /**
   * Call a tool on the MCP server and return the result.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const start = performance.now();
    try {
      const result = await this.client.callTool({ name, arguments: args });
      const latency = Math.round(performance.now() - start);

      this.log.write({
        type: "tool.result",
        t: new Date().toISOString(),
        matchId: this.matchId,
        toolName: name,
        result,
        latencyMs: latency,
      } as LogEntry);

      return result;
    } catch (err) {
      const latency = Math.round(performance.now() - start);
      const message = err instanceof Error ? err.message : String(err);

      this.log.write({
        type: "tool.error",
        t: new Date().toISOString(),
        matchId: this.matchId,
        toolName: name,
        error: message,
        attempt: 0,
        latencyMs: latency,
      } as LogEntry);

      throw err;
    }
  }

  /**
   * Fetches the first system prompt exposed by the MCP server, if any.
   * Returns null if the server exposes no prompts or an error occurs.
   */
  async getSystemPrompt(): Promise<string | null> {
    try {
      const { prompts } = await this.client.listPrompts();
      const firstName = prompts?.[0]?.name;
      if (!firstName) return null;

      const result = await this.client.getPrompt({ name: firstName });
      const text = result.messages
        .map((m) => {
          const c = m.content;
          if (typeof c === "string") return c;
          if (c && typeof c === "object" && "text" in c) return String(c.text);
          return "";
        })
        .join("\n")
        .trim();

      return text || null;
    } catch {
      // Server doesn't support prompts capability — silent fallback
      return null;
    }
  }

  /**
   * Gracefully disconnect from the MCP server.
   */
  async disconnect(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      // ignore close errors
    }
    this.log.write({
      type: "mcp.disconnected",
      t: new Date().toISOString(),
      matchId: this.matchId,
    });
  }
}
