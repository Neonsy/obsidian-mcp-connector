import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { env as hfEnv } from "@huggingface/transformers";
import { mockPlugin, resetMockVault, setMockFile } from "$/test-setup";
import {
  createExclusionsHost,
  createFileHost,
  defaultCachePath,
} from "./hostData";
import { FORMAT_VERSION } from "$/features/semantic-search/services/store";
import type { Listen } from "./cacheLock";
import { wireHeadlessSemanticSearch } from "./semanticSearch";

describe("wireHeadlessSemanticSearch", () => {
  let tmp: string;
  const saved = {
    cacheDir: hfEnv.cacheDir,
    allowLocalModels: hfEnv.allowLocalModels,
    fetch: hfEnv.fetch,
    globalFetch: globalThis.fetch,
  };

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "headless-semantic-"));
  });

  afterEach(async () => {
    // wireHeadlessSemanticSearch points the library's globals at the cache.
    const { globalFetch, ...hf } = saved;
    Object.assign(hfEnv, hf);
    globalThis.fetch = globalFetch;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("the first search's runtime download carries the headers-timeout signal into fetch", async () => {
    resetMockVault();
    setMockFile(
      "Notes/a.md",
      `# Title\n\n${"A sentence long enough to be worth embedding. ".repeat(8)}\n`,
    );
    const seen: Array<{ url: string; signal: AbortSignal | undefined }> = [];
    let reached!: () => void;
    const fetched = new Promise<void>((resolve) => (reached = resolve));
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      seen.push({ url: String(input), signal: init?.signal ?? undefined });
      reached();
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const vault = path.join(tmp, "vault");
    await fs.mkdir(vault);
    const state = await wireHeadlessSemanticSearch(mockPlugin(), vault, {
      XDG_CACHE_HOME: path.join(tmp, "cache"),
    });
    try {
      state?.startIndexerIfNeeded?.();
      await fetched;
      expect(seen[0]?.url).toContain("onnxruntime-web");
      expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(seen[0]?.signal?.aborted).toBe(false);
    } finally {
      await state?.teardown();
    }
  });
  describe("index lock", () => {
    let vault: string;
    let env: Record<string, string>;
    let fetches: number;
    /** Another process owns the lock while true. */
    let otherOwns: boolean;
    /** Whether this process holds the lock right now. */
    let mine: boolean;
    let binds: number;

    const listen: Listen = async () => {
      binds++;
      if (otherOwns) return "in-use";
      mine = true;
      return {
        close: async () => {
          mine = false;
        },
      };
    };

    beforeEach(async () => {
      resetMockVault();
      setMockFile("Notes/a.md", "# Title\n\nA sentence worth embedding.\n");
      fetches = 0;
      otherOwns = false;
      mine = false;
      binds = 0;
      globalThis.fetch = (async () => {
        fetches++;
        throw new Error("offline");
      }) as unknown as typeof fetch;
      vault = path.join(tmp, "vault");
      await fs.mkdir(vault);
      env = { XDG_CACHE_HOME: path.join(tmp, "cache") };
    });

    const wire = () =>
      wireHeadlessSemanticSearch(mockPlugin(), vault, env, { listen });

    test("is not taken at startup, only when the first search starts the indexer", async () => {
      const state = await wire();
      try {
        expect(mine).toBe(false);
        expect(binds).toBe(0);
        await state?.startIndexerIfNeeded?.();
        expect(mine).toBe(true);
        expect(state?.unavailableReason).toBeUndefined();
      } finally {
        await state?.teardown();
      }
    });

    test("a lock held by another process keeps the indexer off and says so", async () => {
      otherOwns = true;
      const state = await wire();
      try {
        await state?.startIndexerIfNeeded?.();
        expect(state?.unavailableReason).toContain("obsidian-mcp-headless");
        expect(state?.unavailableReason).toContain("using the semantic index");
        expect(state?.nativeIndexBuildInProgress).toBeFalsy();
        expect(fetches).toBe(0);
      } finally {
        await state?.teardown();
      }
      expect(mine).toBe(false);
    });

    test("an old-format store under another process's lock is left untouched, and search reports the owner", async () => {
      const dir = path.join(
        defaultCachePath(vault, env),
        "embeddings",
        "native-minilm-l6-v2",
      );
      await fs.mkdir(dir, { recursive: true });
      const stale = JSON.stringify({
        version: FORMAT_VERSION - 1,
        recordCount: 3,
      });
      const files = [
        "embeddings.meta.json",
        "embeddings.index.json",
        "mtimes.json",
      ];
      for (const name of files) await fs.writeFile(path.join(dir, name), stale);
      await fs.writeFile(path.join(dir, "embeddings.bin"), "bytes");
      otherOwns = true;

      const state = await wire();
      try {
        await state?.startIndexerIfNeeded?.();
        expect(state?.unavailableReason).toContain("obsidian-mcp-headless");
        expect(state?.nativeIndexBuildInProgress).toBeFalsy();
        for (const name of [...files, "embeddings.bin"]) {
          expect(existsSync(path.join(dir, name))).toBe(true);
        }
        expect(
          readFileSync(path.join(dir, "embeddings.meta.json"), "utf8"),
        ).toBe(stale);
      } finally {
        await state?.teardown();
      }
    });

    test("a lock that could not be taken reports why", async () => {
      const state = await wireHeadlessSemanticSearch(mockPlugin(), vault, env, {
        listen: () => Promise.reject(new Error("EACCES: no socket")),
      });
      try {
        await state?.startIndexerIfNeeded?.();
        expect(state?.unavailableReason).toContain("EACCES: no socket");
        expect(state?.nativeIndexBuildInProgress).toBeFalsy();
      } finally {
        await state?.teardown();
      }
    });

    test("teardown releases the lock", async () => {
      const state = await wire();
      await state?.startIndexerIfNeeded?.();
      expect(mine).toBe(true);
      await state?.teardown();
      expect(mine).toBe(false);
    });

    test("a search that was refused succeeds once the other process is gone", async () => {
      otherOwns = true;
      const state = await wire();
      try {
        await state?.startIndexerIfNeeded?.();
        expect(state?.unavailableReason).toBeDefined();
        otherOwns = false;
        await state?.startIndexerIfNeeded?.();
        expect(state?.unavailableReason).toBeUndefined();
        expect(mine).toBe(true);
        expect(state?.nativeIndexBuildInProgress).toBe(true);
      } finally {
        await state?.teardown();
      }
    });

    test("with the real socket, a second server for the same vault is refused until the first shuts down", async () => {
      const first = await wireHeadlessSemanticSearch(mockPlugin(), vault, env);
      const second = await wireHeadlessSemanticSearch(mockPlugin(), vault, env);
      try {
        await first?.startIndexerIfNeeded?.();
        expect(first?.unavailableReason).toBeUndefined();
        await second?.startIndexerIfNeeded?.();
        expect(second?.unavailableReason).toContain("obsidian-mcp-headless");
        await first?.teardown();
        await second?.startIndexerIfNeeded?.();
        expect(second?.unavailableReason).toBeUndefined();
      } finally {
        await first?.teardown();
        await second?.teardown();
      }
    });
  });
  describe("HTTP folder exclusions", () => {
    const note = `# Title\n\n${"A sentence long enough to be worth embedding. ".repeat(8)}\n`;
    let vault: string;
    let env: Record<string, string>;
    let fetches: number;

    beforeEach(async () => {
      resetMockVault();
      fetches = 0;
      // Reaching the model means reaching this fetch: nothing is embedded
      // before the runtime files are asked for.
      globalThis.fetch = (async () => {
        fetches++;
        throw new Error("offline");
      }) as unknown as typeof fetch;
      vault = path.join(tmp, "vault");
      await fs.mkdir(vault);
      env = { XDG_CACHE_HOME: path.join(tmp, "cache") };
    });

    /** The HTTP setup: exclusions in the state file, semantic settings apart. */
    async function httpHost(excludedFolders: string[]) {
      const file = path.join(tmp, "state.json");
      const parts = { app: mockPlugin().app, manifest: { version: "0.0.0" } };
      const transport = await createFileHost(parts, file);
      await transport.saveData({ mcpTools: { excludedFolders } });
      const host = createExclusionsHost(parts, transport);
      return mockPlugin({
        loadData: host.loadData,
        saveData: host.saveData,
      } as never);
    }

    /** Run the first indexer start to its end and return the store. */
    async function indexOnce(
      state: Awaited<ReturnType<typeof wireHeadlessSemanticSearch>>,
    ) {
      const indexer = state!.indexer!;
      const start = indexer.start.bind(indexer);
      let started: Promise<void> | undefined;
      // The start follows the gate and the layout-ready barrier by a few
      // microtasks: wait for the call itself.
      const called = new Promise<void>((resolve) => {
        indexer.start = (opts) => {
          started = start(opts);
          resolve();
          return started;
        };
      });
      state!.startIndexerIfNeeded!();
      await called;
      await started!.catch(() => {});
      return state!.store!;
    }

    test("a note in an excluded folder never reaches the embedder or the store", async () => {
      setMockFile("Hidden/secret.md", note);
      const state = await wireHeadlessSemanticSearch(
        await httpHost(["Hidden"]),
        vault,
        env,
      );
      try {
        const store = await indexOnce(state);
        expect(fetches).toBe(0);
        expect(store.size()).toBe(0);
        expect(store.hasRecords("Hidden/secret.md")).toBe(false);
        expect(store.mtimeFor("Hidden/secret.md")).toBeUndefined();
      } finally {
        await state?.teardown();
      }
    });

    test("the same note outside the excluded folder is indexed", async () => {
      setMockFile("Notes/a.md", note);
      const state = await wireHeadlessSemanticSearch(
        await httpHost(["Hidden"]),
        vault,
        env,
      );
      try {
        await indexOnce(state);
        expect(fetches).toBeGreaterThan(0);
      } finally {
        await state?.teardown();
      }
    });

    test("without the shared exclusions the hidden note would be embedded", async () => {
      setMockFile("Hidden/secret.md", note);
      const state = await wireHeadlessSemanticSearch(mockPlugin(), vault, env);
      try {
        await indexOnce(state);
        expect(fetches).toBeGreaterThan(0);
      } finally {
        await state?.teardown();
      }
    });
  });
});
