/**
 * `search_files_by_name` and `rename_vault_file` through their real tool
 * handlers, on a temp vault served by the headless app. The `obsidian`
 * module the unit-test preload mocks is given the headless runtime
 * (`obsidianShim`) for the search helpers, which is what the headless
 * bundle ships, and put back afterwards.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "obsidian";
import * as mocked from "obsidian";
import { ToolRegistryClass } from "$/features/mcp-transport/services/toolRegistry";
import { registerVaultTools } from "$/features/mcp-tools/registerVaultTools";
import { HeadlessFileManager } from "./headlessApp";
import { HeadlessVault } from "./headlessVault";
import {
  parseFrontMatterAliases,
  prepareFuzzySearch,
  sortSearchResults,
} from "./fuzzySearch";

type Handlers = {
  search: typeof import("$/features/mcp-tools/tools/searchFilesByName");
  rename: typeof import("$/features/mcp-tools/tools/renameVaultFile");
};

const original = { ...mocked };
let tools: Handlers;

beforeAll(async () => {
  void mock.module("obsidian", () => ({
    ...original,
    prepareFuzzySearch,
    sortSearchResults,
    parseFrontMatterAliases,
  }));
  tools = {
    search: await import("$/features/mcp-tools/tools/searchFilesByName"),
    rename: await import("$/features/mcp-tools/tools/renameVaultFile"),
  };
});
afterAll(() => {
  void mock.module("obsidian", () => original);
});

let dir: string;
let root: string;
let vault: HeadlessVault;
let app: App;

const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

async function open() {
  vault = await HeadlessVault.open(root);
  await vault.rescan();
  app = {
    vault,
    metadataCache: vault.metadata,
    fileManager: new HeadlessFileManager(vault),
  } as unknown as App;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-tools-"));
  root = path.join(dir, "vault");
  fs.mkdirSync(root);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Result = { content: Array<{ text: string }>; isError?: boolean };
const json = (r: Result) => JSON.parse(r.content[0].text);

describe("registration", () => {
  test("the shared tool set includes both tools", async () => {
    const registry = new ToolRegistryClass();
    await registerVaultTools(registry, {
      app: {} as App,
      plugin: {} as never,
      pluginVersion: "0.0.0-test",
      getLocalTransport: () => undefined,
    });
    const names = registry.list().tools.map((t) => t.name);
    expect(names).toContain("search_files_by_name");
    expect(names).toContain("rename_vault_file");
  });

  test("search_vault_smart is registered only when a semantic host is given", async () => {
    const base = {
      app: {} as App,
      plugin: {} as never,
      pluginVersion: "0.0.0-test",
      getLocalTransport: () => undefined,
    };
    const without = new ToolRegistryClass();
    await registerVaultTools(without, base);
    expect(without.list().tools.map((t) => t.name)).not.toContain(
      "search_vault_smart",
    );

    const host = { semanticSearchState: undefined } as never;
    const withHost = new ToolRegistryClass();
    await registerVaultTools(withHost, { ...base, semanticSearchHost: host });
    expect(withHost.list().tools.map((t) => t.name)).toContain(
      "search_vault_smart",
    );
  });

  test("the registered search_vault_smart reads the given host's state", async () => {
    const registry = new ToolRegistryClass();
    await registerVaultTools(registry, {
      app: {} as App,
      plugin: {} as never,
      pluginVersion: "0.0.0-test",
      getLocalTransport: () => undefined,
      semanticSearchHost: {} as never,
    });
    const result = (await registry.dispatch(
      { name: "search_vault_smart", arguments: { query: "dough" } },
      {} as never,
    )) as Result;
    expect(result.isError).toBe(true);
    expect(json(result).errorCode).toBe("semantic_search_unavailable");
  });

  test("the search description does not claim Obsidian's scorer everywhere", () => {
    const description = JSON.stringify(
      tools.search.searchFilesByNameSchema.toJsonSchema(),
    );
    expect(description).toContain("Obsidian's own on desktop");
    expect(description).not.toContain(
      "using Obsidian's own `prepareFuzzySearch`",
    );
  });
});

describe("search_files_by_name", () => {
  beforeEach(async () => {
    write(
      "Projects/Meeting Notes.md",
      "---\naliases: [standup, Daily Sync]\n---\nx",
    );
    write("Archive/meeting.md", "x");
    write("Other/unrelated.md", "x");
    write("img/meeting.png", "x");
    write("Deep/Folder/m-e-e-t-i-n-g.md", "x");
    await open();
  });

  const search = async (args: Record<string, unknown>) =>
    tools.search.searchFilesByNameHandler({
      arguments: { query: "meeting", ...args },
      app,
    });

  test("finds notes by name, best match first, with Obsidian's result shape", async () => {
    const out = json(await search({}));
    expect(out.query).toBe("meeting");
    expect(out.total).toBe(3);
    expect(out.results.map((r: { path: string }) => r.path)).toEqual([
      "Archive/meeting.md",
      "Projects/Meeting Notes.md",
      "Deep/Folder/m-e-e-t-i-n-g.md",
    ]);
    const [best] = out.results;
    expect(best).toMatchObject({
      basename: "meeting",
      extension: "md",
      matchedOn: "basename",
      matches: [[0, 7]],
    });
    expect(best.score).toBeLessThanOrEqual(0);
    expect(best.uri).toContain("obsidian://");
    const scores = out.results.map((r: { score: number }) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  test("matches frontmatter aliases", async () => {
    const out = json(await search({ query: "standup" }));
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      path: "Projects/Meeting Notes.md",
      matchedOn: "alias",
      alias: "standup",
    });
  });

  test("matches the path", async () => {
    const out = json(await search({ query: "Other/unrel" }));
    expect(out.results[0]).toMatchObject({
      path: "Other/unrelated.md",
      matchedOn: "path",
    });
  });

  test("attachments only when asked", async () => {
    const paths = (o: { results: Array<{ path: string }> }) =>
      o.results.map((r) => r.path);
    expect(paths(json(await search({})))).not.toContain("img/meeting.png");
    expect(paths(json(await search({ includeAttachments: true })))).toContain(
      "img/meeting.png",
    );
  });

  test("folder filter, limit and truncation", async () => {
    const inFolder = json(await search({ folder: "Archive" }));
    expect(inFolder.results.map((r: { path: string }) => r.path)).toEqual([
      "Archive/meeting.md",
    ]);
    const limited = json(await search({ limit: 1 }));
    expect(limited.results).toHaveLength(1);
    expect(limited.total).toBe(3);
    expect(limited.truncated).toBe(true);
    const missing = await search({ folder: "Nope" });
    expect(missing.isError).toBe(true);
    expect(json(missing).errorCode).toBe("folder_not_found");
  });

  test("no match is an empty result", async () => {
    const out = json(await search({ query: "zzzz" }));
    expect(out).toMatchObject({ total: 0, results: [] });
  });
});

describe("rename_vault_file", () => {
  const rename = async (from: string, to: string) =>
    tools.rename.renameVaultFileHandler({ arguments: { from, to }, app });

  beforeEach(async () => {
    write("Notes/old.md", "# Old\n");
    write(
      "A.md",
      '---\nup: "[[old]]"\n---\n[[old|x]] ![[pic.png]] [t](Notes/old.md)\n',
    );
    write("assets/pic.png", "png");
    write("Dir/inner.md", "[[old]]\n");
    await open();
  });

  test("renames a note and rewrites its links", async () => {
    const result = await rename("Notes/old.md", "Notes/new.md");
    expect(result.isError).toBeUndefined();
    expect(json(result)).toEqual({ ok: true, path: "Notes/new.md" });
    expect(read("A.md")).toBe(
      '---\nup: "[[new]]"\n---\n[[new|x]] ![[pic.png]] [t](Notes/new.md)\n',
    );
    expect(read("Dir/inner.md")).toBe("[[new]]\n");
    expect(vault.getFileByPath("Notes/old.md")).toBeNull();
  });

  test("the new name is searchable at once, the old one is gone", async () => {
    await rename("Notes/old.md", "Notes/renamed.md");
    const found = await tools.search.searchFilesByNameHandler({
      arguments: { query: "renamed" },
      app,
    });
    expect(json(found).results[0].path).toBe("Notes/renamed.md");
    const gone = await tools.search.searchFilesByNameHandler({
      arguments: { query: "old.md" },
      app,
    });
    expect(json(gone).results).toEqual([]);
  });

  test("moves an attachment and rewrites embeds", async () => {
    const result = await rename("assets/pic.png", "assets/photo.png");
    expect(json(result)).toEqual({ ok: true, path: "assets/photo.png" });
    expect(read("A.md")).toContain("![[photo.png]]");
  });

  test("renames a folder", async () => {
    const result = await rename("Dir", "Moved");
    expect(json(result)).toEqual({ ok: true, path: "Moved" });
    expect(read("Moved/inner.md")).toBe("[[old]]\n");
    expect(vault.getFileByPath("Dir/inner.md")).toBeNull();
  });

  test.each([
    ["missing.md", "x.md", "file_not_found"],
    ["Notes/old.md", "A.md", "already_exists"],
    ["Notes/old.md", "Nope/old.md", "folder_not_found"],
    ["Notes/old.md", "Notes/old.md", "same_path"],
    ["Notes/old.md", "../escape.md", "folder_not_found"],
    ["Notes/old.md", ".hidden.md", "rename_failed"],
    ["Notes/old.md", ".hidden/old.md", "folder_not_found"],
    ["Notes/old.md", "/abs.md", "rename_failed"],
    ["Notes", "Notes/inner", "rename_failed"],
  ])("%s -> %s is %s", async (from, to, code) => {
    const result = await rename(from, to);
    expect(result.isError).toBe(true);
    expect(json(result).errorCode).toBe(code);
    expect(vault.getFileByPath("Notes/old.md")).not.toBeNull();
    expect(read("A.md")).toContain("[[old|x]]");
  });

  test("a failed link rewrite is reported, the move stands", async () => {
    fs.rmSync(path.join(root, "Dir/inner.md"));
    fs.mkdirSync(path.join(root, "Dir/inner.md"));
    const result = await rename("Notes/old.md", "Notes/new.md");
    expect(result.isError).toBe(true);
    const out = json(result);
    expect(out.errorCode).toBe("rename_failed");
    expect(out.error).toContain("The move succeeded");
    expect(out.error).toContain("Dir/inner.md");
    expect(vault.getFileByPath("Notes/new.md")).not.toBeNull();
    expect(read("A.md")).toContain("[[new|x]]");
  });
});
