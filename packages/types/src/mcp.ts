/**
 * Minimal runtime representation of an MCP tool discovered at connection.
 */
export interface McpTool {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown>;
}
