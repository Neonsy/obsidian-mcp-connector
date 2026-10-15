import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteVaultDirectoryHandler } from "$/features/mcp-tools/tools/deleteVaultDirectory";
import { createHeadlessApp, type HeadlessAppHandle } from "./headlessApp";
import { HeadlessVault } from "./headlessVault";
import { TFile, TFolder } from "./obsidianShim";
import { VaultPathError } from "./vaultFs";

/** The shim classes stand in for Obsidian's; the app type wants the real ones. */
const asObsidian = (f: TFile) => f as never;

let dir: string;
let root: string;
let handle: HeadlessAppHandle;
let vault: HeadlessVault;

const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};

async function open() {
  handle = await createHeadlessApp(root);
  vault = handle.vault;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-vault-"));
  root = path.join(dir, "vault");
  fs.mkdirSync(root);
});
afterEach(() => {
  handle?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = (rel: string): TFile => {
  const f = vault.getFileByPath(rel);
  if (!f) throw new Error(`missing ${rel}`);
  return f;
};

describe("indexing", () => {
  test("indexes files and folders, skips hidden ones", async () => {
    write("a.md", "# A");
    write("sub/b.md", "# B");
    write("sub/img.png", "x");
    write(".obsidian/app.json", "{}");
    write(".git/config", "x");
    write("sub/.hidden/c.md", "x");
    await open();

    expect(
      vault
        .getFiles()
        .map((f) => f.path)
        .sort(),
    ).toEqual(["a.md", "sub/b.md", "sub/img.png"]);
    expect(
      vault
        .getMarkdownFiles()
        .map((f) => f.path)
        .sort(),
    ).toEqual(["a.md", "sub/b.md"]);
    expect(vault.getAllFolders().map((f) => f.path)).toEqual(["sub"]);
    expect(vault.getAbstractFileByPath(".obsidian/app.json")).toBeNull();
    expect(vault.getAbstractFileByPath("sub")).toBeInstanceOf(TFolder);
    expect(file("sub/b.md")).toBeInstanceOf(TFile);
    expect(file("sub/b.md").basename).toBe("b");
    expect(file("sub/b.md").parent?.path).toBe("sub");
  });

  test("symlinks are skipped, wherever they point", async () => {
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.md"), "s");
    write("a.md", "a");
    write("real/b.md", "b");
    fs.symlinkSync(outside, path.join(root, "link"));
    fs.symlinkSync("real", path.join(root, "alias"));
    fs.symlinkSync("a.md", path.join(root, "twin.md"));
    fs.symlinkSync("gone.md", path.join(root, "dangling.md"));
    await open();
    expect(
      vault
        .getFiles()
        .map((f) => f.path)
        .sort(),
    ).toEqual(["a.md", "real/b.md"]);
    expect(vault.getAllFolders().map((f) => f.path)).toEqual(["real"]);
  });
});

describe("writes are visible before the promise resolves", () => {
  test("create updates cache, tags and links at once", async () => {
    write("Target.md", "# Target");
    await open();
    await vault
      .create("notes/New.md", "---\nstatus: new\n---\nHi #fresh [[Target]]\n")
      .catch(() => {});
    // The parent folder is missing, as in Obsidian.
    expect(vault.getFileByPath("notes/New.md")).toBeNull();

    await vault.createFolder("notes");
    const created = await vault.create(
      "notes/New.md",
      "---\nstatus: new\n---\nHi #fresh [[Target]]\n",
    );
    const cache = vault.metadata.getFileCache(created);
    expect(cache?.frontmatter?.status).toBe("new");
    expect(cache?.tags?.map((t) => t.tag)).toEqual(["#fresh"]);
    expect(vault.metadata.getTags()["#fresh"]).toBe(1);
    expect(vault.metadata.resolvedLinks["notes/New.md"]).toEqual({
      "Target.md": 1,
    });
    expect(fs.readFileSync(path.join(root, "notes/New.md"), "utf8")).toContain(
      "status: new",
    );
  });

  test("creating a link target re-resolves an unchanged source", async () => {
    write("A.md", "see [[B]]");
    await open();
    expect(vault.metadata.unresolvedLinks["A.md"]).toEqual({ B: 1 });
    expect(vault.metadata.resolvedLinks["A.md"]).toEqual({});

    await vault.create("B.md", "b");
    expect(vault.metadata.resolvedLinks["A.md"]).toEqual({ "B.md": 1 });
    expect(vault.metadata.unresolvedLinks["A.md"]).toEqual({});

    await vault.delete(file("B.md"));
    expect(vault.metadata.unresolvedLinks["A.md"]).toEqual({ B: 1 });
  });

  test("create refuses to replace an existing file", async () => {
    write("A.md", "keep");
    await open();
    await expect(vault.create("A.md", "new")).rejects.toThrow("already exists");
    expect(fs.readFileSync(path.join(root, "A.md"), "utf8")).toBe("keep");
  });

  test("createFolder reports an existing folder like Obsidian", async () => {
    write("sub/a.md", "a");
    await open();
    await expect(vault.createFolder("sub")).rejects.toThrow("already exists");
    await vault.createFolder("x/y/z");
    expect(vault.getFolderByPath("x/y/z")).toBeInstanceOf(TFolder);
  });
});

describe("process and processFrontMatter", () => {
  test("concurrent edits to one file are serialised, none lost", async () => {
    write("c.md", "0");
    await open();
    const f = file("c.md");
    await Promise.all(
      Array.from({ length: 20 }, () =>
        vault.process(f, (data) => String(Number(data) + 1)),
      ),
    );
    expect(fs.readFileSync(path.join(root, "c.md"), "utf8")).toBe("20");
  });

  test("concurrent frontmatter edits are serialised too", async () => {
    write("p.md", "---\nn: 0\n---\nbody\n");
    await open();
    const f = file("p.md");
    await Promise.all(
      Array.from({ length: 10 }, () =>
        handle.app.fileManager.processFrontMatter(asObsidian(f), (fm) => {
          fm.n = (fm.n as number) + 1;
        }),
      ),
    );
    expect(fs.readFileSync(path.join(root, "p.md"), "utf8")).toBe(
      "---\nn: 10\n---\nbody\n",
    );
    expect(vault.metadata.getFileCache(f)?.frontmatter?.n).toBe(10);
  });

  test("no temp files are left behind", async () => {
    write("t.md", "x");
    await open();
    await vault.modify(file("t.md"), "y");
    expect(fs.readdirSync(root)).toEqual(["t.md"]);
  });
});

describe("confinement", () => {
  test("hostile paths are refused before touching the disk", async () => {
    await open();
    for (const bad of [
      "../x.md",
      "/etc/x.md",
      "a/../../x.md",
      ".git/x",
      "a\0.md",
    ]) {
      await expect(vault.create(bad, "x")).rejects.toThrow(VaultPathError);
    }
    expect(fs.existsSync(path.join(dir, "x.md"))).toBe(false);
  });

  test("a symlinked folder out of the vault cannot be written through", async () => {
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "link"));
    await open();
    await expect(vault.create("link/pwn.md", "x")).rejects.toThrow(
      VaultPathError,
    );
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test("fs errors do not reveal the host path", async () => {
    write("a.md", "a");
    await open();
    const f = file("a.md");
    fs.rmSync(path.join(root, "a.md"));
    const err = await vault.read(f).catch((e: Error) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect((err as Error).message).not.toContain(dir);
  });
});

describe("delete and trash", () => {
  test("trashFile moves into .trash without indexing it", async () => {
    write("gone.md", "bye");
    await open();
    await handle.app.fileManager.trashFile(asObsidian(file("gone.md")));
    expect(vault.getFileByPath("gone.md")).toBeNull();
    expect(fs.readFileSync(path.join(root, ".trash/gone.md"), "utf8")).toBe(
      "bye",
    );
    expect(vault.getFiles()).toEqual([]);
  });

  test("a second trashed file of the same name does not overwrite", async () => {
    write("n.md", "1");
    await open();
    await handle.app.fileManager.trashFile(asObsidian(file("n.md")));
    await vault.create("n.md", "2");
    await handle.app.fileManager.trashFile(asObsidian(file("n.md")));
    expect(fs.readdirSync(path.join(root, ".trash")).length).toBe(2);
  });

  test("adapter.rmdir removes a folder tree from disk and index", async () => {
    write("d/a.md", "a");
    write("d/e/b.md", "b");
    await open();
    const adapter = vault.adapter;
    await expect(adapter.rmdir("d", false)).rejects.toMatchObject({
      code: "ENOTEMPTY",
    });
    await adapter.rmdir("d", true);
    expect(vault.getFiles()).toEqual([]);
    expect(vault.getAllFolders()).toEqual([]);
    expect(await adapter.exists("d")).toBe(false);
  });
});

describe("the vault root is never removed or replaced", () => {
  const spellings = ["", ".", "./", "a/..", "self"];

  beforeEach(() => {
    write("a.md", "a");
    fs.symlinkSync(".", path.join(root, "self"));
  });

  test.each(spellings.map((p) => [p]))("rmdir(%p) is refused", async (p) => {
    await open();
    await expect(vault.adapter.rmdir(p, true)).rejects.toThrow(VaultPathError);
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("a");
  });

  test("delete_vault_directory with path '.' leaves the vault alone", async () => {
    await open();
    const result = await deleteVaultDirectoryHandler({
      arguments: { path: ".", recursive: true },
      app: handle.app,
    });
    expect(result.isError).toBe(true);
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("a");
  });

  test("delete and trash refuse a folder that resolves to the root", async () => {
    await open();
    const alias = new TFolder(vault, "self");
    await expect(vault.delete(alias)).rejects.toThrow(VaultPathError);
    await expect(vault.trash(alias)).rejects.toThrow(VaultPathError);
    expect(fs.readFileSync(path.join(root, "a.md"), "utf8")).toBe("a");
  });

  test("a write never targets the root", async () => {
    await open();
    await expect(vault.create("self", "x")).rejects.toThrow(VaultPathError);
    expect(fs.readdirSync(dir)).toEqual(["vault"]);
  });
});

describe("trash destinations", () => {
  test("same-named files trashed within one clock tick all survive", async () => {
    write("n.md", "1");
    const fixed = await HeadlessVault.open(root, { now: () => 1000 });
    await fixed.rescan();
    for (const next of ["2", "3", null]) {
      await fixed.trash(fixed.getFileByPath("n.md") as TFile);
      if (next !== null) await fixed.create("n.md", next);
    }
    const trash = path.join(root, ".trash");
    const contents = fs
      .readdirSync(trash)
      .map((name) => fs.readFileSync(path.join(trash, name), "utf8"))
      .sort();
    expect(contents).toEqual(["1", "2", "3"]);
  });

  test("a .trash symlink out of the vault is refused", async () => {
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, ".trash"));
    write("keep.md", "k");
    await open();
    const err = await vault.trash(file("keep.md")).catch((e: Error) => e);
    expect(err).toBeInstanceOf(VaultPathError);
    expect((err as Error).message).toContain(".trash");
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(path.join(root, "keep.md"), "utf8")).toBe("k");
    expect(vault.getFileByPath("keep.md")).not.toBeNull();
  });
});

describe("symlinks inside the vault", () => {
  let outside: string;

  beforeEach(() => {
    outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "o.md"), "outside");
    write("real/r.md", "real");
    write(".obsidian/settings.json", "hidden-setting");
    fs.symlinkSync("real/r.md", path.join(root, "file-link.md"));
    fs.symlinkSync("real", path.join(root, "dir-link"));
    fs.symlinkSync(outside, path.join(root, "out-link"));
    fs.symlinkSync(".obsidian", path.join(root, "Alias"));
  });

  const ghost = (rel: string) =>
    new TFile(vault, rel, { ctime: 0, mtime: 0, size: 0 });

  test("cannot be read, even by a path the index never offered", async () => {
    await open();
    for (const rel of [
      "file-link.md",
      "dir-link/r.md",
      "out-link/o.md",
      "Alias/settings.json",
    ]) {
      expect(vault.getAbstractFileByPath(rel)).toBeNull();
      await expect(vault.read(ghost(rel))).rejects.toThrow(VaultPathError);
    }
  });

  test("delete, trash and rmdir refuse them and leave the targets alone", async () => {
    await open();
    await expect(vault.delete(ghost("file-link.md"))).rejects.toThrow(
      VaultPathError,
    );
    await expect(vault.trash(ghost("file-link.md"))).rejects.toThrow(
      VaultPathError,
    );
    await expect(vault.delete(new TFolder(vault, "dir-link"))).rejects.toThrow(
      VaultPathError,
    );
    await expect(vault.adapter.rmdir("dir-link", true)).rejects.toThrow(
      VaultPathError,
    );
    await expect(vault.adapter.rmdir("out-link", true)).rejects.toThrow(
      VaultPathError,
    );
    expect(fs.readFileSync(path.join(root, "real/r.md"), "utf8")).toBe("real");
    expect(fs.readFileSync(path.join(outside, "o.md"), "utf8")).toBe("outside");
    expect(fs.lstatSync(path.join(root, "file-link.md")).isSymbolicLink()).toBe(
      true,
    );
    expect(fs.existsSync(path.join(root, ".trash"))).toBe(false);
  });

  test("nothing is written through them", async () => {
    await open();
    for (const rel of ["dir-link/new.md", "out-link/new.md", "Alias/new.md"]) {
      await expect(vault.create(rel, "x")).rejects.toThrow(VaultPathError);
    }
    await expect(vault.createFolder("dir-link/sub")).rejects.toThrow(
      VaultPathError,
    );
    expect(fs.readdirSync(path.join(root, "real"))).toEqual(["r.md"]);
    expect(fs.readdirSync(outside)).toEqual(["o.md"]);
    expect(fs.readdirSync(path.join(root, ".obsidian"))).toEqual([
      "settings.json",
    ]);
  });

  test("a symlinked vault root, or one below a dot-folder, still works", async () => {
    const nested = path.join(dir, ".vaults", "x");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "a.md"), "a");
    const link = path.join(dir, "vault-link");
    fs.symlinkSync(nested, link);
    handle = await createHeadlessApp(link);
    vault = handle.vault;
    expect(vault.getFiles().map((f) => f.path)).toEqual(["a.md"]);
    await vault.create("b.md", "b");
    expect(fs.readFileSync(path.join(nested, "b.md"), "utf8")).toBe("b");
  });
});

describe("edits keep the file's permission bits", () => {
  test.each([
    ["0600", 0o600],
    ["0640", 0o640],
  ])("mode %s", async (_, mode) => {
    write("p.md", "---\nn: 0\n---\nbody\n");
    fs.chmodSync(path.join(root, "p.md"), mode);
    await open();
    await vault.modify(file("p.md"), "---\nn: 1\n---\nbody\n");
    expect(fs.statSync(path.join(root, "p.md")).mode & 0o777).toBe(mode);
    await handle.app.fileManager.processFrontMatter(
      asObsidian(file("p.md")),
      (fm) => {
        fm.n = 2;
      },
    );
    expect(fs.statSync(path.join(root, "p.md")).mode & 0o777).toBe(mode);
    expect(fs.readFileSync(path.join(root, "p.md"), "utf8")).toContain("n: 2");
  });
});

describe("a note that cannot be parsed", () => {
  test("a self-referencing YAML anchor does not stop the scan", async () => {
    write("loop.md", "---\na: &self\n  link: '[[B]]'\n  next: *self\n---\n");
    write("B.md", "b");
    await open();
    expect(vault.getFileByPath("loop.md")).not.toBeNull();
    expect(vault.metadata.resolvedLinks["loop.md"]).toEqual({ "B.md": 1 });
  });
});

describe("index updates never interleave with a rescan", () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  /**
   * A vault whose rescans count their listings and can be held between
   * listing the disk and applying the listing. `queued(n)` resolves once
   * n index updates have joined the queue.
   */
  async function openHeld() {
    let hold: { reached: () => void; release: Promise<void> } | null = null;
    let count = 0;
    const waiting = new Map<number, () => void>();
    const held = {
      listings: 0,
      vault: await HeadlessVault.open(root, {
        afterScanList: async () => {
          held.listings += 1;
          const h = hold;
          hold = null;
          if (h === null) return;
          h.reached();
          await h.release;
        },
        onQueued: () => {
          count += 1;
          waiting.get(count)?.();
        },
      }),
      /** Hold the next rescan; resolves with its release once it is held. */
      async hold(): Promise<() => void> {
        const reached = deferred();
        const release = deferred();
        hold = { reached: reached.resolve, release: release.promise };
        await reached.promise;
        return release.resolve;
      },
      queued(n: number): Promise<void> {
        const target = count + n;
        return new Promise((resolve) => waiting.set(target, resolve));
      },
    };
    await held.vault.rescan();
    return held;
  }

  const indexed = (v: HeadlessVault) =>
    v
      .getFiles()
      .map((f) => f.path)
      .sort();
  /** The files at the vault root, where these tests keep all of theirs. */
  const onDisk = () =>
    fs
      .readdirSync(root)
      .filter((p) => fs.statSync(path.join(root, p)).isFile())
      .sort();

  test("watcher updates that arrive during a rescan are applied after it", async () => {
    write("keep.md", "k");
    write("pic.png", "x");
    const held = await openHeld();
    const { vault: v } = held;
    const holding = held.hold();
    const scanned = v.rescan();
    const release = await holding;

    write("new.md", "n");
    fs.rmSync(path.join(root, "pic.png"));
    // What the watcher runs for the two events. An unordered update
    // finishes at once; an ordered one waits behind the held scan.
    const queued = held.queued(2);
    const settled = Promise.all([
      v.reconcile("new.md"),
      v.reconcile("pic.png"),
    ]);
    await Promise.race([settled, queued]);
    release();
    await Promise.all([scanned, settled]);

    expect(onDisk()).toEqual(["keep.md", "new.md"]);
    expect(indexed(v)).toEqual(onDisk());
  });

  test("a tool write during a rescan is not undone by the older listing", async () => {
    write("keep.md", "k");
    write("pic.png", "x");
    const held = await openHeld();
    const { vault: v } = held;
    const holding = held.hold();
    const scanned = v.rescan();
    const release = await holding;

    const queued = held.queued(2);
    const written = Promise.all([
      v.create("new.md", "n #fresh"),
      v.delete(v.getFileByPath("pic.png") as TFile),
    ]);
    await Promise.race([written, queued]);
    release();
    await Promise.all([scanned, written]);

    expect(onDisk()).toEqual(["keep.md", "new.md"]);
    expect(indexed(v)).toEqual(onDisk());
    expect(v.metadata.getTags()["#fresh"]).toBe(1);
  });

  test("rescans requested during a rescan coalesce into one more", async () => {
    write("a.md", "a");
    const held = await openHeld();
    const { vault: v } = held;
    const holding = held.hold();
    const first = v.rescan();
    const release = await holding;
    expect(held.listings).toBe(2);

    const more = [v.rescan(), v.rescan(), v.rescan()];
    release();
    await Promise.all([first, ...more]);
    expect(held.listings).toBe(3);
  });
});
