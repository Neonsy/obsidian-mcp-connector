import type { App } from "obsidian";
import type { McpHost } from "$/shared/types";
import type { ToolRegistrar } from "$/composeToolRegistry";
import { SettingsStore } from "$/shared/settingsStore";
import { logger } from "$/shared";
import { ensureEverCalledTracking } from "$/features/adaptive-tool-loading/services/migrationEligibility";
import {
  startHttpServer,
  stopHttpServer,
  type RunningServer,
} from "./httpServer";
import {
  createMcpService,
  destroyMcpService,
  type McpService,
} from "./mcpServer";
import { resolvePorts } from "./port";
import { ensureTokenStore, readTokens } from "./tokenStore";

export type McpTransportState = {
  server: RunningServer;
  mcp: McpService;
  bearerToken: string;
};

export type SetupResult =
  | { success: true; state: McpTransportState }
  | { success: false; error: string };

/**
 * Resolve the effective MCP `serverInfo.name` reported during the
 * `initialize` handshake: the user's configured value if non-blank,
 * else "Obsidian - <vault name>" so multi-vault setups are
 * distinguishable in MCP clients that display this field verbatim
 * (see issue #329).
 */
export function resolveServerName(
  app: App,
  configured: string | undefined,
): string {
  const trimmed = configured?.trim();
  return trimmed ? trimmed : `Obsidian - ${app.vault.getName()}`;
}

export type TransportSetupOptions<H extends McpHost> = {
  /** The host's tool set, see ToolRegistrar. */
  registerTools: ToolRegistrar<H>;
  /** `initialize` instructions text; the desktop default when omitted. */
  instructions?: string;
  /**
   * Bind exactly these ports in order instead of reading the saved port
   * settings. The headless `--port` flag passes one, which makes a busy
   * port a startup error rather than a silent fallback.
   */
  ports?: number[];
  /** See `stale` in setupTransport. */
  stale?: () => boolean;
};

/**
 * Initialize the MCP HTTP transport for a host.
 *
 * Brings the token store to its current shape (minting the first-run
 * token if needed), then starts the in-process MCP server and HTTP
 * listener.
 *
 * A token is generated once, on first load, and stored in data.json under
 * `mcpTransport.tokens`. Subsequent loads reuse the stored strings so that
 * clients don't need to re-authenticate on every plugin reload.
 *
 * Args:
 *   plugin: The host (provides app/loadData/saveData/manifest): the Obsidian
 *     plugin on the desktop, a vault-directory shim in the headless server.
 *   options: The host's tool set and instructions, plus the optional port
 *     override and `stale`.
 *   stale (option): True once this plugin instance was unloaded (ADR-0027). A stale
 *     setup never publishes its port as `livePort`: a reloaded instance may
 *     already have published its own port, which the `.mcpb` shim and the
 *     next port preference read. The broker forwards to the port a vault
 *     registers, not to `livePort`.
 *
 * Returns:
 *   SetupResult — success with the running state, or failure with an error message.
 */
export async function setupTransport<H extends McpHost>(
  plugin: H,
  options: TransportSetupOptions<H>,
): Promise<SetupResult> {
  const stale = options.stale ?? (() => false);
  try {
    // First statement of setup, and before the listener binds: mints
    // the first-run token, migrates a 0.28.2 vault to the multi-token
    // shape and self-heals the legacy mirror, all idempotently. A
    // server accepting requests against an empty token list would 401
    // every client.
    const tokens = await ensureTokenStore(plugin);
    // The mirror, which is `tokens[0]` by position (ADR-0014 §7).
    const bearerToken = tokens[0].token;
    // A DIFFERENT owner from ensureTokenStore, deliberately not folded into
    // it: this writes the migration-eligibility anchor
    // (`toolLoading.everCalledSince`), idempotently, once per vault
    // (ADR-0025 D3). Keeping it a separate call after ensureTokenStore's
    // own write lets `tokenStore.test.ts`'s save-count assertions stay
    // green without knowing about this feature.
    await ensureEverCalledTracking(plugin);

    const mcpTransportSlice = (await new SettingsStore(plugin).readSlice(
      "mcpTransport",
    )) as
      | { port?: unknown; livePort?: unknown; serverName?: string }
      | undefined;
    const ports =
      options.ports ??
      resolvePorts(mcpTransportSlice?.port, mcpTransportSlice?.livePort);
    const serverName = resolveServerName(
      plugin.app,
      mcpTransportSlice?.serverName,
    );

    const mcp = await createMcpService({
      app: plugin.app,
      plugin,
      pluginVersion: plugin.manifest.version,
      serverName,
      registerTools: options.registerTools,
      instructions: options.instructions,
    });
    let server: RunningServer;
    try {
      server = await startHttpServer({
        // Re-read on every request rather than closing over `tokens`: a
        // captured list would keep a revoked token working until the next
        // Obsidian restart, and it is what lets the settings UI add,
        // rotate and revoke tokens without restarting the transport
        // (ADR-0014 §2).
        resolveTokens: () => readTokens(plugin),
        requestHandler: mcp.handleRequest,
        ports,
      });
    } catch (err) {
      // A single-element `ports` list means the user configured a fixed
      // port: bindWithFallback's own "range exhausted" error (no .code)
      // means that one port was busy. Any other error (e.g. a genuine
      // EACCES/EADDRNOTAVAIL, which carries a .code) passes through
      // unchanged — only the busy-fixed-port case gets the friendlier
      // message. No fallback to the range: that would reintroduce the
      // cross-session port drift a fixed port is meant to fix (#337).
      if (ports.length === 1 && err instanceof Error && !("code" in err)) {
        throw new Error(
          `Port ${ports[0]} is in use — the MCP server did not start. Free it or change the port in settings.`,
        );
      }
      throw err;
    }

    // Persist the actually-bound port (post-fallback), distinct from the
    // user's optional Fixed Port setting (`mcpTransport.port`). The
    // generated .mcpb reads this at spawn time (mcpbGenerator.ts) so an
    // already-installed Claude Desktop extension keeps working across a
    // port that drifted, without a manual re-export, and the next start
    // tries it first (resolvePorts). The broker does not use it: it
    // forwards to the port a vault registers (ADR-0027). Checked inside
    // the write as well, so
    // an unload during the read cannot slip a stale port through.
    let published = false;
    await new SettingsStore(plugin).updateSlice("mcpTransport", (current) => {
      if (stale()) return current; // NO_CHANGE
      published = true;
      const slice = (current as Record<string, unknown> | undefined) ?? {};
      if (slice.livePort === server.port) return current; // NO_CHANGE
      return { ...slice, livePort: server.port };
    });
    if (!published) {
      await teardown({ server, mcp, bearerToken });
      return { success: false, error: "The plugin was unloaded" };
    }

    logger.info("MCP Connector HTTP server listening", {
      port: server.port,
      pluginVersion: plugin.manifest.version,
    });

    return { success: true, state: { server, mcp, bearerToken } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("MCP Connector failed to start HTTP server", {
      error: message,
    });
    return { success: false, error: message };
  }
}

/**
 * Gracefully shut down the MCP HTTP transport.
 *
 * Stops the HTTP server first (releases the port), then destroys the MCP
 * service (closes transport + server). Order matters: stopping HTTP first
 * prevents new requests from reaching a half-closed MCP service.
 *
 * Args:
 *   state: The McpTransportState returned by a successful setup() call.
 */
export async function teardown(state: McpTransportState): Promise<void> {
  await stopHttpServer(state.server);
  logger.info("MCP Connector HTTP server stopped", {
    port: state.server.port,
  });
  await destroyMcpService(state.mcp);
}
