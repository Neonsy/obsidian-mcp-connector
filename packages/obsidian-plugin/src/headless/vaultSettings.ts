/**
 * The vault's Obsidian settings the headless server honours, read once at
 * startup from `.obsidian/`. The vault tools never touch dot-folders, so
 * this is the server's own read: it follows no symlink on the way to a file, caps the size it
 * reads, and treats a missing or unreadable file as "Obsidian defaults".
 * Nothing watches the folder, so a changed setting needs a restart.
 */

import fs from "node:fs/promises";
import path from "node:path";

const CONFIG_DIR = ".obsidian";
const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * Read `.obsidian/<rel>` as JSON. Undefined when the file is absent, or it or
 * any folder above it is a symlink, is too large or is not valid JSON (the last two say so once
 * through `warn`).
 */
export async function readConfigJson(
  root: string,
  rel: string,
  warn: (message: string) => void,
): Promise<unknown> {
  const parts = [CONFIG_DIR, ...rel.split("/")];
  const file = path.join(root, ...parts);
  try {
    // Every component below the vault root, so a symlinked folder in the
    // middle (`.obsidian/plugins` pointing outside) is refused too.
    for (let i = 1; i <= parts.length; i++) {
      const stat = await fs.lstat(path.join(root, ...parts.slice(0, i)));
      if (stat.isSymbolicLink()) return undefined;
    }
    const stat = await fs.stat(file);
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_CONFIG_BYTES) {
      warn(`Ignoring ${CONFIG_DIR}/${rel}: larger than 1 MB`);
      return undefined;
    }
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch (err) {
    if (err instanceof SyntaxError) {
      warn(`Ignoring ${CONFIG_DIR}/${rel}: invalid JSON`);
    }
    return undefined;
  }
}

export type VaultSettings = {
  /** `Files & Links` -> `Excluded files`: path prefixes and `/regex/` entries. */
  userIgnoreFilters: string[];
};

/** Obsidian's defaults, used for every setting the file does not give. */
export const DEFAULT_VAULT_SETTINGS: VaultSettings = { userIgnoreFilters: [] };

/** Pick the known settings out of a parsed `app.json`, ignoring bad values. */
export function parseAppSettings(json: unknown): VaultSettings {
  const raw =
    typeof json === "object" && json !== null && !Array.isArray(json)
      ? (json as Record<string, unknown>).userIgnoreFilters
      : undefined;
  return {
    userIgnoreFilters: Array.isArray(raw)
      ? raw.filter((f): f is string => typeof f === "string")
      : [],
  };
}

export async function loadVaultSettings(
  root: string,
  warn: (message: string) => void,
): Promise<VaultSettings> {
  return parseAppSettings(await readConfigJson(root, "app.json", warn));
}

/**
 * The "Excluded files" test. An entry wrapped in slashes (`/\.png$/`) is a
 * regular expression tested against the vault-relative path, any other
 * entry is a path prefix. An invalid expression, an empty entry and an
 * empty expression (`//`) match nothing.
 */
export function createIgnoreMatcher(
  filters: readonly string[],
): (path: string) => boolean {
  const prefixes: string[] = [];
  const patterns: RegExp[] = [];
  for (const filter of filters) {
    if (filter === "") continue;
    if (filter.length > 2 && filter.startsWith("/") && filter.endsWith("/")) {
      try {
        patterns.push(new RegExp(filter.slice(1, -1)));
      } catch {
        // An invalid expression excludes nothing.
      }
    } else if (filter !== "//") {
      prefixes.push(filter);
    }
  }
  if (prefixes.length === 0 && patterns.length === 0) return () => false;
  return (p) =>
    prefixes.some((prefix) => p.startsWith(prefix)) ||
    patterns.some((re) => re.test(p));
}
