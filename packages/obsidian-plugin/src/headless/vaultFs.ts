/**
 * Path confinement for the headless vault.
 *
 * Every vault path that reaches the disk goes through `VaultFs`. The
 * lexical rules (no `..`, no absolute paths, no control characters, no hidden
 * segments) reject a hostile path before any fs call. Symlinks below the
 * root are not part of the vault: a path through one, in any segment, is
 * refused, so every path served is the lexical path joined on the root. The root
 * itself may be a symlink; it is resolved once when the vault opens, and
 * only segments below it count, so a vault in `~/.vaults/x` is served.
 *
 * Known limit: the check and the later fs call are two steps, so a local
 * user who can already write into the vault and swaps a directory for a
 * symlink between them could win the race. The server binds loopback and
 * serves one user's vault, so that attacker is already inside the trust
 * boundary.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Thrown for a path the vault refuses. `code` follows the Node errno style. */
export class VaultPathError extends Error {
  constructor(
    message: string,
    readonly code: "EINVAL" | "EACCES",
  ) {
    super(message);
    this.name = "VaultPathError";
  }
}

/** True when `segment` names a hidden entry, which the vault neither indexes nor writes. */
export function isHiddenSegment(segment: string): boolean {
  return segment.startsWith(".");
}

/** True when any segment of the vault-relative path is hidden. */
export function isHiddenPath(rel: string): boolean {
  return rel.split("/").some(isHiddenSegment);
}

/**
 * Normalise a vault-relative path: `/` separators, no leading or trailing
 * slash, no empty or `.` segments. Throws VaultPathError for control characters,
 * absolute paths, `..` segments and hidden segments. The empty string is
 * the vault root and is allowed.
 */
export function normalizeVaultPath(input: string): string {
  // A control character (a newline above all) can inject structure into the
  // YAML or markdown that a rename writes the path into.
  if (/[\u0000-\u001f\u007f]/.test(input)) {
    throw new VaultPathError("Path contains a control character", "EINVAL");
  }
  const slashed = input.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) {
    throw new VaultPathError("Absolute paths are not allowed", "EINVAL");
  }
  const segments: string[] = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new VaultPathError("Path escapes the vault root", "EACCES");
    }
    if (isHiddenSegment(segment)) {
      throw new VaultPathError(
        "Hidden paths are not part of the vault",
        "EACCES",
      );
    }
    segments.push(segment);
  }
  return segments.join("/");
}

export class VaultFs {
  private constructor(
    /** Realpath of the vault directory. */
    readonly root: string,
  ) {}

  static async open(dir: string): Promise<VaultFs> {
    const real = await fs.realpath(dir);
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${dir}`);
    }
    return new VaultFs(real);
  }

  /**
   * Absolute disk path for a vault-relative path. Refuses a path that
   * passes through a symlink below the root. A path that does not exist
   * yet is checked up to its nearest existing ancestor.
   */
  async resolve(rel: string): Promise<string> {
    const segments = normalizeVaultPath(rel).split("/").filter(Boolean);
    let abs = this.root;
    for (const segment of segments) {
      abs = path.join(abs, segment);
      const stat = await fs.lstat(abs).catch(() => null);
      if (stat === null) break;
      if (stat.isSymbolicLink()) {
        throw new VaultPathError(
          "Symlinks are not part of the vault",
          "EACCES",
        );
      }
    }
    return path.join(this.root, ...segments);
  }

  /**
   * `resolve` for an operation that removes, moves or replaces the entry.
   * Refuses the vault root itself, however it is spelled: `""`, `.`, `./`.
   */
  async resolveEntry(rel: string): Promise<string> {
    const abs = await this.resolve(rel);
    if (abs === this.root) {
      throw new VaultPathError("The vault root cannot be changed", "EACCES");
    }
    return abs;
  }

  /**
   * Path of `<vault>/.trash`, created when missing. Refused unless it is a
   * real folder: a `.trash` symlink would move trashed files elsewhere.
   */
  async trashDir(): Promise<string> {
    const dir = path.join(this.root, ".trash");
    await fs.mkdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    if (!(await fs.lstat(dir)).isDirectory()) {
      throw new VaultPathError(
        "The .trash folder is not a folder inside the vault",
        "EACCES",
      );
    }
    return dir;
  }

  /** `resolve`, or null for a refused path. For lookups, which must not throw. */
  async tryResolve(rel: string): Promise<string | null> {
    try {
      return await this.resolve(rel);
    } catch (err) {
      if (err instanceof VaultPathError) return null;
      throw err;
    }
  }
}
