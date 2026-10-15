import type McpToolsPlugin from "$/main";
import { registerTools } from "$/features/mcp-tools";
import { SERVER_INSTRUCTIONS } from "./mcpServer";
import { setupTransport, type SetupResult } from "./transportSetup";

export {
  resolveServerName,
  teardown,
  type McpTransportState,
  type SetupResult,
} from "./transportSetup";

/**
 * Initialize the MCP HTTP transport for the Obsidian plugin: the
 * host-agnostic setup (see transportSetup.ts) with the desktop tool set
 * and instructions.
 *
 * Args:
 *   plugin: The Obsidian Plugin instance (provides loadData/saveData/manifest).
 *   stale: True once this plugin instance was unloaded (ADR-0027).
 */
export function setup(
  plugin: McpToolsPlugin,
  stale: () => boolean = () => false,
): Promise<SetupResult> {
  return setupTransport(plugin, {
    registerTools,
    instructions: SERVER_INSTRUCTIONS,
    stale,
  });
}
