/**
 * Entry point of the headless server: the MCP vault tools served from a
 * vault directory, with no Obsidian.
 *
 * Stdio (default) is what an MCP client that spawns the server speaks:
 * newline-delimited JSON-RPC on stdin and stdout, nothing else on stdout.
 * `--http` is the always-on service: 127.0.0.1 only, bearer token from the
 * same token store the desktop plugin uses.
 */

import fs from "node:fs/promises";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { updateTokenPolicy } from "$/features/adaptive-tool-loading/tokenPolicyStore";
import { registerVaultTools } from "$/features/mcp-tools/registerVaultTools";
import {
  createMcpService,
  destroyMcpService,
} from "$/features/mcp-transport/services/mcpServer";
import { ensureTokenStore } from "$/features/mcp-transport/services/tokenStore";
import {
  resolveServerName,
  setupTransport,
  teardown,
} from "$/features/mcp-transport/services/transportSetup";
import type { ToolRegistrar } from "$/composeToolRegistry";
import { logger } from "$/shared/logger";
import { DEFAULT_LOG_LEVEL } from "$/shared/log/logLine";
import type { SemanticSearchState } from "$/features/semantic-search/setup";
import type { SemanticHost } from "$/features/semantic-search/types";
import type { McpHost } from "$/shared/types";
import manifest from "../../../../manifest.json";
import { parseArgs, unsupportedNodeReason } from "./args";
import { createHeadlessApp } from "./headlessApp";
import {
  checkDataOutsideVault,
  createExclusionsHost,
  createFileHost,
  createMemoryHost,
  defaultDataPath,
} from "./hostData";
import { HEADLESS_INSTRUCTIONS } from "./instructions";
import { wireHeadlessSemanticSearch } from "./semanticSearch";
import { createShutdown, unrefTimer } from "./shutdown";
import { routeConsoleToStderr, stderrLogFs } from "./stderrLogFs";

/** The token id a stdio session is served under; there is no real token. */
const STDIO_SESSION = "stdio";

const hostManifest = { id: manifest.id, version: manifest.version };

function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

function onShutdown(cleanup: () => Promise<void>): void {
  const shutdown = createShutdown(cleanup, {
    exit: (code) => process.exit(code),
    say,
    startTimer: unrefTimer,
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
}

/**
 * Semantic search with its own in-memory settings, kept apart from the
 * transport's host: it has nothing to persist, and the HTTP state file
 * should hold only the token. The folder exclusions are the one thing it
 * reads from the transport's host, so the index skips what the tools hide.
 * Nothing downloads until the first `search_vault_smart` call. A failed
 * setup is logged and leaves the tool unregistered.
 */
async function startSemanticSearch(
  app: McpHost["app"],
  vaultRealPath: string,
  transportHost: McpHost,
): Promise<{ host: SemanticHost; state: SemanticSearchState } | undefined> {
  const host: SemanticHost = createExclusionsHost(
    { app, manifest: hostManifest },
    transportHost,
  );
  try {
    const state = await wireHeadlessSemanticSearch(host, vaultRealPath);
    if (!state) return undefined;
    host.semanticSearchState = state;
    return { host, state };
  } catch (err) {
    say(
      `Semantic search is off: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

async function serveOverStdio(
  vaultDir: string,
  semantic: boolean,
): Promise<void> {
  routeConsoleToStderr();
  const { app, close } = await createHeadlessApp(vaultDir, { warn: say });
  const host = createMemoryHost({ app, manifest: hostManifest });
  const search = semantic
    ? await startSemanticSearch(app, await fs.realpath(vaultDir), host)
    : undefined;
  // No token means no stored policy, and an unknown id would get the
  // restricted "adaptive" profile. A client that spawned this process owns
  // it, so the whole tool set is its surface.
  await updateTokenPolicy(host, STDIO_SESSION, { profile: "all" });
  const service = await createMcpService({
    app,
    plugin: host,
    pluginVersion: hostManifest.version,
    serverName: resolveServerName(app, undefined),
    registerTools: registrarFor(() => undefined, search?.host),
    instructions: HEADLESS_INSTRUCTIONS,
  });
  const handle = serveStdio((ctx) =>
    service.buildMcpServer(STDIO_SESSION, ctx.era === "modern"),
  );
  say(
    `obsidian-mcp-headless ${hostManifest.version} serving ${vaultDir} over stdio`,
  );
  onShutdown(async () => {
    await handle.close();
    await destroyMcpService(service);
    await search?.state.teardown();
    close();
    await logger.flush();
  });
}

async function serveOverHttp(
  vaultDir: string,
  options: {
    port?: number;
    data?: string;
    printToken: boolean;
    semantic: boolean;
  },
): Promise<void> {
  const real = await fs.realpath(vaultDir);
  const dataFile = await checkDataOutsideVault(
    options.data ?? defaultDataPath(real),
    real,
  );

  if (options.printToken) {
    // The token store needs a host with an `app` only for the server name,
    // which printing does not use.
    const host = await createFileHost(
      { app: {} as McpHost["app"], manifest: hostManifest },
      dataFile,
    );
    const tokens = await ensureTokenStore(host);
    process.stdout.write(`${tokens[0].token}\n`);
    return;
  }

  const { app, close } = await createHeadlessApp(real, { warn: say });
  const host = await createFileHost({ app, manifest: hostManifest }, dataFile);
  const search = options.semantic
    ? await startSemanticSearch(app, real, host)
    : undefined;
  let boundPort: number | undefined;
  const result = await setupTransport(host, {
    registerTools: registrarFor(
      () =>
        boundPort === undefined
          ? undefined
          : {
              protocol: "http",
              host: "127.0.0.1",
              port: boundPort,
              path: "/mcp",
            },
      search?.host,
    ),
    instructions: HEADLESS_INSTRUCTIONS,
    ports: options.port === undefined ? undefined : [options.port],
  });
  if (!result.success) {
    await search?.state.teardown();
    close();
    throw new Error(result.error);
  }
  boundPort = result.state.server.port;
  say(`obsidian-mcp-headless ${hostManifest.version} serving ${real}`);
  say(`Listening on http://127.0.0.1:${boundPort}/mcp`);
  say(`Bearer token: run with --http --print-token (state file: ${dataFile})`);
  onShutdown(async () => {
    await teardown(result.state);
    await search?.state.teardown();
    close();
    await logger.flush();
  });
}

function registrarFor(
  getLocalTransport: Parameters<
    typeof registerVaultTools
  >[1]["getLocalTransport"],
  semanticSearchHost?: SemanticHost,
): ToolRegistrar {
  return (registry, ctx) =>
    registerVaultTools(registry, {
      app: ctx.app,
      plugin: ctx.plugin,
      pluginVersion: ctx.pluginVersion,
      getLocalTransport,
      semanticSearchHost,
    });
}

async function main(): Promise<void> {
  const unsupported = unsupportedNodeReason(process.versions.node);
  if (unsupported) {
    say(unsupported);
    process.exitCode = 1;
    return;
  }
  const args = parseArgs(process.argv.slice(2), process.env);
  if (args.kind === "help") {
    process.stdout.write(`${args.text}\n`);
    return;
  }
  if (args.kind === "error") {
    say(args.message);
    process.exitCode = 2;
    return;
  }
  logger.configure({ dir: "", level: DEFAULT_LOG_LEVEL, fs: stderrLogFs });
  if (args.http) await serveOverHttp(args.vault, args);
  else await serveOverStdio(args.vault, args.semantic);
}

main().catch((err: unknown) => {
  say(
    `obsidian-mcp-headless: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
