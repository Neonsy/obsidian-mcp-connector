import type { App } from "obsidian";
import type McpToolsPlugin from "$/main";
import type { ToolRegistry } from "$/features/mcp-transport/services/toolRegistry";
import { registerVaultTools } from "./registerVaultTools";

export { default as FeatureSettings } from "./components/McpToolsSettingsSection.svelte";

import {
  getActiveFileHandler,
  getActiveFileSchema,
} from "./tools/getActiveFile";
import {
  updateActiveFileHandler,
  updateActiveFileSchema,
} from "./tools/updateActiveFile";
import {
  appendToActiveFileHandler,
  appendToActiveFileSchema,
} from "./tools/appendToActiveFile";
import {
  patchActiveFileHandler,
  patchActiveFileSchema,
} from "./tools/patchActiveFile";
import {
  deleteActiveFileHandler,
  deleteActiveFileSchema,
} from "./tools/deleteActiveFile";
import {
  showFileInObsidianHandler,
  showFileInObsidianSchema,
} from "./tools/showFileInObsidian";
import {
  getWorkspaceStateHandler,
  getWorkspaceStateSchema,
} from "./tools/getWorkspaceState";
import {
  searchVaultSmartHandler,
  searchVaultSmartSchema,
  type SearchVaultSmartContext,
} from "./tools/searchVaultSmart";
import {
  listObsidianCommandsHandler,
  listObsidianCommandsSchema,
} from "./tools/listObsidianCommands";
import {
  executeObsidianCommandHandler,
  executeObsidianCommandSchema,
} from "./tools/executeObsidianCommand";
import { fetchHandler, fetchSchema } from "./tools/fetch";
import {
  executeTemplateHandler,
  executeTemplateSchema,
} from "./tools/executeTemplate";
import {
  getOrCreateDailyNoteHandler,
  getOrCreateDailyNoteSchema,
} from "./tools/getOrCreateDailyNote";
import {
  getOrCreatePeriodicNoteHandler,
  getOrCreatePeriodicNoteSchema,
} from "./tools/getOrCreatePeriodicNote";
import {
  appendToPeriodicNoteHandler,
  appendToPeriodicNoteSchema,
} from "./tools/appendToPeriodicNote";
import {
  executeDataviewQueryHandler,
  executeDataviewQuerySchema,
} from "./tools/executeDataviewQuery";
import {
  listBookmarksHandler,
  listBookmarksSchema,
} from "./tools/listBookmarks";

export type RegisterToolsContext = {
  app: App;
  plugin: McpToolsPlugin;
  pluginVersion: string;
};

export async function registerTools(
  registry: ToolRegistry,
  ctx: RegisterToolsContext,
): Promise<void> {
  await registerVaultTools(registry, {
    app: ctx.app,
    plugin: ctx.plugin,
    pluginVersion: ctx.pluginVersion,
    getLocalTransport: () => {
      // Lazy: at registration time the HTTP server has not bound yet,
      // so plugin.mcpTransportState is undefined. By tool-call time
      // setup() has populated it with a live RunningServer.
      const port = ctx.plugin.mcpTransportState?.server.port;
      if (port === undefined) return undefined;
      return {
        protocol: "http",
        host: "127.0.0.1",
        port,
        path: "/mcp",
      };
    },
  });

  // Active file
  registry.register(getActiveFileSchema, async ({ arguments: args }) =>
    getActiveFileHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(updateActiveFileSchema, async ({ arguments: args }) =>
    updateActiveFileHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );
  registry.register(appendToActiveFileSchema, async ({ arguments: args }) =>
    appendToActiveFileHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(patchActiveFileSchema, async ({ arguments: args }) =>
    patchActiveFileHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );
  registry.register(deleteActiveFileSchema, async ({ arguments: args }) =>
    deleteActiveFileHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );
  registry.register(showFileInObsidianSchema, async ({ arguments: args }) =>
    showFileInObsidianHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getWorkspaceStateSchema, async ({ arguments: args }) =>
    getWorkspaceStateHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(listBookmarksSchema, async ({ arguments: args }) =>
    listBookmarksHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(
    searchVaultSmartSchema,
    async (params, { sendNotification, hasUiCapability }) =>
      searchVaultSmartHandler({
        arguments: (
          params as { arguments: SearchVaultSmartContext["arguments"] }
        ).arguments,
        app: ctx.app,
        plugin: ctx.plugin,
        progressToken: (
          params as { _meta?: { progressToken?: string | number } }
        )._meta?.progressToken,
        sendNotification,
        hasUiCapability,
      }),
  );
  registry.register(executeDataviewQuerySchema, async ({ arguments: args }) =>
    executeDataviewQueryHandler({ arguments: args, app: ctx.app }),
  );
  // Commands
  registry.register(listObsidianCommandsSchema, async ({ arguments: args }) =>
    listObsidianCommandsHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(executeObsidianCommandSchema, async ({ arguments: args }) =>
    executeObsidianCommandHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );
  // Periodic notes
  registry.register(getOrCreateDailyNoteSchema, async ({ arguments: args }) =>
    getOrCreateDailyNoteHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(
    getOrCreatePeriodicNoteSchema,
    async ({ arguments: args }) =>
      getOrCreatePeriodicNoteHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(appendToPeriodicNoteSchema, async ({ arguments: args }) =>
    appendToPeriodicNoteHandler({ arguments: args, app: ctx.app }),
  );
  // Misc
  registry.register(fetchSchema, async ({ arguments: args }) =>
    fetchHandler({ arguments: args }),
  );
  registry.register(executeTemplateSchema, async ({ arguments: args }) =>
    executeTemplateHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );
}
