import type { App } from "obsidian";
import type { PluginDataLike } from "$/shared/types";
import type { ToolRegistry } from "$/features/mcp-transport/services/toolRegistry";
import { TOOL_ANNOTATIONS } from "./toolAnnotations";
import { TOOL_CLIENT_META, TOOL_TITLES } from "./toolClientMeta";

import {
  getServerInfoHandler,
  getServerInfoSchema,
  type LocalTransportInfo,
} from "./tools/getServerInfo";
import { listTasksHandler, listTasksSchema } from "./tools/listTasks";
import {
  getNotePropertiesHandler,
  getNotePropertiesSchema,
} from "./tools/getNoteProperties";
import {
  updateNotePropertiesHandler,
  updateNotePropertiesSchema,
} from "./tools/updateNoteProperties";
import { renameTagHandler, renameTagSchema } from "./tools/renameTag";
import { getFileInfoHandler, getFileInfoSchema } from "./tools/getFileInfo";
import {
  ensureBlockIdHandler,
  ensureBlockIdSchema,
} from "./tools/ensureBlockId";
import {
  listAttachmentsHandler,
  listAttachmentsSchema,
} from "./tools/listAttachments";
import {
  updateCanvasNodeHandler,
  updateCanvasNodeSchema,
} from "./tools/updateCanvasNode";
import {
  deleteCanvasNodeHandler,
  deleteCanvasNodeSchema,
} from "./tools/deleteCanvasNode";
import {
  setTaskStatusHandler,
  setTaskStatusSchema,
} from "./tools/setTaskStatus";
import {
  listVaultFilesHandler,
  listVaultFilesSchema,
} from "./tools/listVaultFiles";
import { getVaultFileHandler, getVaultFileSchema } from "./tools/getVaultFile";
import {
  getVaultFilesHandler,
  getVaultFilesSchema,
} from "./tools/getVaultFiles";
import {
  createVaultFileHandler,
  createVaultFileSchema,
} from "./tools/createVaultFile";
import {
  createVaultBinaryFileHandler,
  createVaultBinaryFileSchema,
} from "./tools/createVaultBinaryFile";
import {
  appendToVaultFileHandler,
  appendToVaultFileSchema,
} from "./tools/appendToVaultFile";
import {
  patchVaultFileHandler,
  patchVaultFileSchema,
} from "./tools/patchVaultFile";
import {
  deleteVaultFileHandler,
  deleteVaultFileSchema,
} from "./tools/deleteVaultFile";
import {
  renameHeadingHandler,
  renameHeadingSchema,
} from "./tools/renameHeading";
import {
  createVaultDirectoryHandler,
  createVaultDirectorySchema,
} from "./tools/createVaultDirectory";
import {
  deleteVaultDirectoryHandler,
  deleteVaultDirectorySchema,
} from "./tools/deleteVaultDirectory";
import {
  renameVaultFileHandler,
  renameVaultFileSchema,
} from "./tools/renameVaultFile";
import {
  searchFilesByNameHandler,
  searchFilesByNameSchema,
} from "./tools/searchFilesByName";
import { searchVaultHandler, searchVaultSchema } from "./tools/searchVault";
import {
  searchVaultSmartHandler,
  searchVaultSmartSchema,
  type SearchVaultSmartContext,
} from "./tools/searchVaultSmart";
import type { SemanticHost } from "$/features/semantic-search/types";
import {
  searchVaultSimpleHandler,
  searchVaultSimpleSchema,
} from "./tools/searchVaultSimple";
import { listTagsHandler, listTagsSchema } from "./tools/listTags";
import {
  getFilesByTagHandler,
  getFilesByTagSchema,
} from "./tools/getFilesByTag";
import {
  getNotePropertyHandler,
  getNotePropertySchema,
} from "./tools/getNoteProperty";
import {
  setNotePropertyHandler,
  setNotePropertySchema,
} from "./tools/setNoteProperty";
import {
  deleteNotePropertyHandler,
  deleteNotePropertySchema,
} from "./tools/deleteNoteProperty";
import {
  listPropertyValuesHandler,
  listPropertyValuesSchema,
} from "./tools/listPropertyValues";
import {
  getRecentFilesHandler,
  getRecentFilesSchema,
} from "./tools/getRecentFiles";
import {
  getVaultOverviewHandler,
  getVaultOverviewSchema,
} from "./tools/getVaultOverview";
import {
  getVaultFilePartialHandler,
  getVaultFilePartialSchema,
} from "./tools/getVaultFilePartial";
import {
  getOutgoingLinksHandler,
  getOutgoingLinksSchema,
} from "./tools/getOutgoingLinks";
import { getBacklinksHandler, getBacklinksSchema } from "./tools/getBacklinks";
import {
  findBrokenLinksHandler,
  findBrokenLinksSchema,
} from "./tools/findBrokenLinks";
import {
  findOrphanedNotesHandler,
  findOrphanedNotesSchema,
} from "./tools/findOrphanedNotes";
import {
  searchAndReplaceHandler,
  searchAndReplaceSchema,
} from "./tools/searchAndReplace";
import {
  getNoteOutlineHandler,
  getNoteOutlineSchema,
} from "./tools/getNoteOutline";
import { getCanvasHandler, getCanvasSchema } from "./tools/getCanvas";
import {
  addCanvasNodeHandler,
  addCanvasNodeSchema,
} from "./tools/addCanvasNode";
import {
  connectCanvasNodesHandler,
  connectCanvasNodesSchema,
} from "./tools/connectCanvasNodes";

export type RegisterVaultToolsContext = {
  app: App;
  plugin: PluginDataLike;
  pluginVersion: string;
  /**
   * Lazy for the same reason as `get_server_info`'s own hook: at
   * registration time the HTTP server has not bound yet.
   */
  getLocalTransport: () => LocalTransportInfo | undefined;
  /**
   * Register `search_vault_smart` for this host. Omitted, the tool is
   * not registered. The host carries `semanticSearchState`, which the
   * caller assigns once the feature is wired.
   */
  semanticSearchHost?: SemanticHost;
};

/**
 * The tools that need nothing but a vault-shaped `App` and a settings
 * host: no workspace, commands, Dataview, Templater or UI. The desktop
 * `registerTools` calls this and adds the desktop-only tools; the
 * headless server registers this set alone. Kept free of Svelte, Modal
 * and settings-UI imports so the headless bundle never reaches them.
 */
export async function registerVaultTools(
  registry: ToolRegistry,
  ctx: RegisterVaultToolsContext,
): Promise<void> {
  // Health
  registry.register(getServerInfoSchema, async ({ arguments: args }) =>
    getServerInfoHandler({
      arguments: args,
      pluginVersion: ctx.pluginVersion,
      getLocalTransport: ctx.getLocalTransport,
    }),
  );
  // Tasks
  registry.register(listTasksSchema, async ({ arguments: args }) =>
    listTasksHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(setTaskStatusSchema, async ({ arguments: args }) =>
    setTaskStatusHandler({ arguments: args, app: ctx.app }),
  );
  // Frontmatter, whole-block variants
  registry.register(getNotePropertiesSchema, async ({ arguments: args }) =>
    getNotePropertiesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(updateNotePropertiesSchema, async ({ arguments: args }) =>
    updateNotePropertiesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(renameTagSchema, async ({ arguments: args }) =>
    renameTagHandler({ arguments: args, app: ctx.app }),
  );
  // File metadata without the body
  registry.register(getFileInfoSchema, async ({ arguments: args }) =>
    getFileInfoHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(listAttachmentsSchema, async ({ arguments: args }) =>
    listAttachmentsHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(ensureBlockIdSchema, async ({ arguments: args }) =>
    ensureBlockIdHandler({ arguments: args, app: ctx.app }),
  );
  // Vault file ops
  registry.register(listVaultFilesSchema, async ({ arguments: args }) =>
    listVaultFilesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getVaultFileSchema, async ({ arguments: args }) =>
    getVaultFileHandler({ arguments: args, app: ctx.app, plugin: ctx.plugin }),
  );
  registry.register(getVaultFilesSchema, async ({ arguments: args }) =>
    getVaultFilesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(createVaultFileSchema, async ({ arguments: args }) =>
    createVaultFileHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );
  registry.register(createVaultBinaryFileSchema, async ({ arguments: args }) =>
    createVaultBinaryFileHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );
  registry.register(appendToVaultFileSchema, async ({ arguments: args }) =>
    appendToVaultFileHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(patchVaultFileSchema, async ({ arguments: args }) =>
    patchVaultFileHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );
  registry.register(deleteVaultFileSchema, async ({ arguments: args }) =>
    deleteVaultFileHandler({
      arguments: args,
      app: ctx.app,
      plugin: ctx.plugin,
    }),
  );
  registry.register(renameHeadingSchema, async ({ arguments: args }) =>
    renameHeadingHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(createVaultDirectorySchema, async ({ arguments: args }) =>
    createVaultDirectoryHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(deleteVaultDirectorySchema, async ({ arguments: args }) =>
    deleteVaultDirectoryHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(renameVaultFileSchema, async ({ arguments: args }) =>
    renameVaultFileHandler({ arguments: args, app: ctx.app }),
  );
  // Metadata
  registry.register(listTagsSchema, async ({ arguments: args }) =>
    listTagsHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getFilesByTagSchema, async ({ arguments: args }) =>
    getFilesByTagHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getNotePropertySchema, async ({ arguments: args }) =>
    getNotePropertyHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(setNotePropertySchema, async ({ arguments: args }) =>
    setNotePropertyHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(deleteNotePropertySchema, async ({ arguments: args }) =>
    deleteNotePropertyHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(listPropertyValuesSchema, async ({ arguments: args }) =>
    listPropertyValuesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getRecentFilesSchema, async ({ arguments: args }) =>
    getRecentFilesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getVaultOverviewSchema, async ({ arguments: args }) =>
    getVaultOverviewHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getVaultFilePartialSchema, async ({ arguments: args }) =>
    getVaultFilePartialHandler({ arguments: args, app: ctx.app }),
  );
  // Links
  registry.register(getOutgoingLinksSchema, async ({ arguments: args }) =>
    getOutgoingLinksHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getBacklinksSchema, async ({ arguments: args }) =>
    getBacklinksHandler({ arguments: args, app: ctx.app }),
  );
  // Vault intelligence
  registry.register(findBrokenLinksSchema, async ({ arguments: args }) =>
    findBrokenLinksHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(findOrphanedNotesSchema, async ({ arguments: args }) =>
    findOrphanedNotesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(searchAndReplaceSchema, async ({ arguments: args }) =>
    searchAndReplaceHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(getNoteOutlineSchema, async ({ arguments: args }) =>
    getNoteOutlineHandler({ arguments: args, app: ctx.app }),
  );
  // Canvas
  registry.register(getCanvasSchema, async ({ arguments: args }) =>
    getCanvasHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(addCanvasNodeSchema, async ({ arguments: args }) =>
    addCanvasNodeHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(connectCanvasNodesSchema, async ({ arguments: args }) =>
    connectCanvasNodesHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(updateCanvasNodeSchema, async ({ arguments: args }) =>
    updateCanvasNodeHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(deleteCanvasNodeSchema, async ({ arguments: args }) =>
    deleteCanvasNodeHandler({ arguments: args, app: ctx.app }),
  );
  // Search
  registry.register(searchFilesByNameSchema, async ({ arguments: args }) =>
    searchFilesByNameHandler({ arguments: args, app: ctx.app }),
  );
  registry.register(searchVaultSchema, async ({ arguments: args }) =>
    searchVaultHandler({
      arguments: args,
      app: ctx.app,
    }),
  );
  // `hasUiCapability` rides the HandlerContext the same way
  // `sendNotification` does (R-09, ADR-0023 D9). Forwarded as-is,
  // `undefined` included: the tools distinguish "declared no support"
  // from "no signal at all", and collapsing the two here would silently
  // strip the payload from every legacy-era call.
  registry.register(
    searchVaultSimpleSchema,
    async ({ arguments: args }, { hasUiCapability }) =>
      searchVaultSimpleHandler({
        arguments: args,
        app: ctx.app,
        hasUiCapability,
      }),
  );

  const semanticHost = ctx.semanticSearchHost;
  if (semanticHost) {
    registry.register(
      searchVaultSmartSchema,
      async (params, { sendNotification, hasUiCapability }) =>
        searchVaultSmartHandler({
          arguments: (
            params as { arguments: SearchVaultSmartContext["arguments"] }
          ).arguments,
          app: ctx.app,
          plugin: semanticHost,
          progressToken: (
            params as { _meta?: { progressToken?: string | number } }
          )._meta?.progressToken,
          sendNotification,
          hasUiCapability,
        }),
    );
  }

  // Covers the meta-tools registered later in mcpServer.ts too:
  // annotations are looked up by name at list() time.
  registry.setAnnotations(TOOL_ANNOTATIONS);
  // Same by-name contract: `title` for the MCP Apps frame and the
  // `anthropic/*` hints Claude Code reads (alwaysLoad on the meta-tools,
  // maxResultSizeChars on the large-output tools). setMeta merges, so the
  // MCP Apps pointer wired later in composeToolRegistry sits beside them.
  registry.setTitles(TOOL_TITLES);
  registry.setMeta(TOOL_CLIENT_META);
  // Deliberately NO registry.setOutputSchemas() call here. The MCP SDK
  // client rejects every non-error response of a tool that advertises an
  // outputSchema unless it carries structuredContent, so a polymorphic
  // tool (get_vault_file returns text OR image OR audio OR a JSON hint)
  // can never declare one — doing so in 0.27.2 broke every default-format
  // get_vault_file call with -32600. index.test.ts guards this.
}
