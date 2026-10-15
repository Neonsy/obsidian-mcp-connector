/**
 * The `App` the MCP tools run against when there is no Obsidian: a vault
 * directory behind the same surface, restricted to what the retained
 * tools call. Wrapped in `createGuardedApp` by the shared composition
 * root exactly like the desktop `App`.
 */

import type { App } from "obsidian";
import { editFrontmatter } from "./frontmatterEdit";
import { HeadlessVault, type HeadlessVaultOptions } from "./headlessVault";
import { TFile, type TAbstractFile } from "./obsidianShim";
import { createLinkRewriter } from "./renameLinks";
import { VaultWatcher } from "./watcher";

export class HeadlessFileManager {
  constructor(private readonly vault: HeadlessVault) {}

  processFrontMatter(
    file: TFile,
    fn: (frontmatter: Record<string, unknown>) => void,
  ): Promise<void> {
    return this.vault.processText(file, (content) =>
      editFrontmatter(content, fn),
    );
  }

  trashFile(file: TFile): Promise<void> {
    return this.vault.trash(file);
  }

  /**
   * Move a file or folder, then rewrite the links that pointed at it (and
   * the relative links inside it) in every affected note. The move stands
   * if a note cannot be rewritten, or holds a link that no spelling can
   * lead to its target: the error then names the notes whose links are out
   * of date, and those links. It also stands when a hidden temporary name
   * of the file could not be removed, and the error names that name.
   */
  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    const { moves, before, linkers, leftover } = await this.vault.rename(
      file,
      newPath,
    );
    const rewriter = createLinkRewriter(before, moves);
    const failed: string[] = [];
    for (const oldPath of linkers) {
      const path = moves.get(oldPath) ?? oldPath;
      const note = this.vault.getFileByPath(path);
      if (note === null) continue;
      try {
        let unwritable: string[] = [];
        await this.vault.process(note, (content) => {
          const next = rewriter.rewrite(
            content,
            this.vault.metadata.getFileCacheIfCurrent(note, content),
            oldPath,
          );
          unwritable = next.unwritable;
          return next.content;
        });
        if (unwritable.length > 0) {
          failed.push(
            `${path} (no spelling leads to the target of ${unwritable.join(", ")})`,
          );
        }
      } catch (err) {
        failed.push(`${path} (${err instanceof Error ? err.message : err})`);
      }
    }
    if (failed.length > 0 || leftover !== undefined) {
      const problems: string[] = [];
      if (failed.length > 0) {
        problems.push(
          `links were not updated in ${failed.length} note(s): ${failed.join(", ")}`,
        );
      }
      if (leftover !== undefined) {
        problems.push(
          `the temporary name ${leftover} could not be removed and can be deleted`,
        );
      }
      throw Object.assign(
        new Error(`The move succeeded, but ${problems.join(" and ")}`),
        { code: failed.length > 0 ? "ELINKS" : "ELEFTOVER" },
      );
    }
  }
}

/** Nothing is ever open on a server, so every workspace question has the empty answer. */
const workspace = {
  getActiveFile: (): TFile | null => null,
  onLayoutReady: (callback: () => void): void => callback(),
  layoutReady: true,
  on: () => ({}),
  off: () => {},
  offref: () => {},
  trigger: () => {},
};

export type HeadlessAppHandle = {
  app: App;
  vault: HeadlessVault;
  /** Stop the file watcher. */
  close: () => void;
};

/**
 * Start watching the vault directory, index it, and return the app. The
 * watcher opens first and holds its events through the scan, so an edit
 * made while the scan runs is reconciled once it is done.
 */
export async function createHeadlessApp(
  vaultDir: string,
  options: HeadlessVaultOptions = {},
): Promise<HeadlessAppHandle> {
  const vault = await HeadlessVault.open(vaultDir, options);
  const watcher = new VaultWatcher(vault);
  watcher.start({ held: true });
  vault.flushPending = () => watcher.flush();
  try {
    await vault.rescan();
    await watcher.release();
  } catch (err) {
    watcher.stop();
    throw err;
  }
  const app = {
    vault,
    metadataCache: vault.metadata,
    fileManager: new HeadlessFileManager(vault),
    workspace,
    // Dataview and Templater are desktop plugins; `search_vault` reads this
    // to answer `dataview_not_installed`.
    plugins: { plugins: {} },
  } as unknown as App;
  return { app, vault, close: () => watcher.stop() };
}
