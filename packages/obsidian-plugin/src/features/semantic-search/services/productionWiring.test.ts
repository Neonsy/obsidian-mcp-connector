import { describe, expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  isIndexableFile,
  probeAndWipeStaleStores,
  purgeExcludedFromStores,
  wireSemanticSearch,
} from "./productionWiring";
import { createEmbeddingStoreRegistry } from "./storeRegistry";
import type { SemanticIndexer } from "./indexer";
import {
  FORMAT_VERSION,
  type EmbeddingRecord,
  type VaultAdapter,
} from "./store";
import { compilePolicy, EMPTY_POLICY } from "$/shared/pathPolicy";
import { pathPolicyFor } from "$/shared/policyProvider";
import { TFile } from "obsidian";
import {
  fireMockVaultEvent,
  mockPlugin,
  resetMockVault,
  setMockFile,
} from "$/test-setup";
import { captureLogLines } from "$/shared/log/logCapture";

/** In-memory adapter tracking text + binary files and remove() calls. */
function memAdapter() {
  const files = new Map<string, string>();
  const bins = new Map<string, ArrayBuffer>();
  const removed: string[] = [];
  const adapter: VaultAdapter = {
    async exists(p) {
      return files.has(p) || bins.has(p);
    },
    async read(p) {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    async write(p, d) {
      files.set(p, d);
    },
    async readBinary(p) {
      const v = bins.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v.slice(0);
    },
    async writeBinary(p, d) {
      bins.set(p, d.slice(0));
    },
    async remove(p) {
      removed.push(p);
      if (!files.delete(p) && !bins.delete(p)) {
        throw new Error(`ENOENT ${p}`);
      }
    },
    async mkdir() {},
  };
  return { adapter, files, bins, removed: () => removed };
}

const BASE = "/p/embeddings";

/** Write a store's index + meta sidecar at a given format version. */
function seedStore(
  mem: ReturnType<typeof memAdapter>,
  key: string,
  version: number,
  recordCount: number,
) {
  const dir = `${BASE}/${key}`;
  mem.files.set(
    `${dir}/embeddings.index.json`,
    JSON.stringify({ version, records: new Array(recordCount).fill({}) }),
  );
  mem.files.set(
    `${dir}/embeddings.meta.json`,
    JSON.stringify({ version, recordCount }),
  );
  mem.bins.set(`${dir}/embeddings.bin`, new ArrayBuffer(8));
  mem.files.set(`${dir}/mtimes.json`, "{}");
}

describe("probeAndWipeStaleStores", () => {
  test("empty base dir: no stale keys, no counts, no removals", async () => {
    const mem = memAdapter();
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const { staleKeys, probedCounts } = await probeAndWipeStaleStores(
      registry,
      mem.adapter,
      BASE,
    );
    expect(staleKeys).toEqual([]);
    expect(probedCounts).toEqual({});
    expect(mem.removed()).toEqual([]);
  });

  test("current non-empty store is marked ready with its count, not wiped", async () => {
    const mem = memAdapter();
    seedStore(mem, "native-minilm-l6-v2", FORMAT_VERSION, 42);
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const { staleKeys, probedCounts } = await probeAndWipeStaleStores(
      registry,
      mem.adapter,
      BASE,
    );
    expect(staleKeys).toEqual([]);
    expect(probedCounts["native-minilm-l6-v2"]).toBe(42);
    expect(registry.isReady("native-minilm-l6-v2")).toBe(true);
    expect(mem.removed()).toEqual([]);
    // Files survive.
    expect(
      await mem.adapter.exists(`${BASE}/native-minilm-l6-v2/embeddings.bin`),
    ).toBe(true);
  });

  test("stale store: reported stale AND all its files wiped (legacy pair + segments)", async () => {
    const mem = memAdapter();
    const key = "native-minilm-l6-v2";
    seedStore(mem, key, FORMAT_VERSION - 1, 10);
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const { staleKeys, probedCounts } = await probeAndWipeStaleStores(
      registry,
      mem.adapter,
      BASE,
    );
    expect(staleKeys).toEqual([key]);
    expect(probedCounts).toEqual({});
    expect(registry.isReady(key)).toBe(false);
    // Every candidate file is attempted best-effort: the legacy pair,
    // the sidecars, and each segment pair (a stale store may be in
    // either layout, or mid-migration in both).
    const dir = `${BASE}/${key}`;
    const expectedTargets = [
      `${dir}/embeddings.bin`,
      `${dir}/embeddings.index.json`,
      `${dir}/embeddings.index.json.writing`,
      `${dir}/mtimes.json`,
      `${dir}/embeddings.meta.json`,
    ];
    for (let seg = 0; seg < 16; seg++) {
      expectedTargets.push(
        `${dir}/embeddings.seg${seg}.bin`,
        `${dir}/embeddings.seg${seg}.index.json`,
      );
    }
    expect(mem.removed()).toEqual(expectedTargets);
    expect(await mem.adapter.exists(`${dir}/embeddings.bin`)).toBe(false);
    expect(await mem.adapter.exists(`${dir}/embeddings.index.json`)).toBe(
      false,
    );
  });

  test("a current store and a stale store: only the stale one is wiped", async () => {
    const mem = memAdapter();
    seedStore(mem, "native-minilm-l6-v2", FORMAT_VERSION, 5);
    seedStore(mem, "embedding-gemma-300m", FORMAT_VERSION - 1, 9);
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const { staleKeys, probedCounts } = await probeAndWipeStaleStores(
      registry,
      mem.adapter,
      BASE,
    );
    expect(staleKeys).toEqual(["embedding-gemma-300m"]);
    expect(probedCounts).toEqual({ "native-minilm-l6-v2": 5 });
    expect(
      await mem.adapter.exists(`${BASE}/native-minilm-l6-v2/embeddings.bin`),
    ).toBe(true);
    expect(
      await mem.adapter.exists(`${BASE}/embedding-gemma-300m/embeddings.bin`),
    ).toBe(false);
  });
});

describe("isIndexableFile", () => {
  // Builds an object that passes `instanceof TFile` (the obsidian mock
  // wires up the prototype) with an explicit `extension`, without
  // depending on MockTFile.
  function fakeTFile(path: string, extension: string): TFile {
    const f = Object.create(TFile.prototype) as TFile;
    Object.assign(f, { path, extension });
    return f;
  }

  test("accepts a .md TFile", () => {
    expect(isIndexableFile(fakeTFile("Notes/a.md", "md"))).toBe(true);
  });

  test("rejects a .pdf TFile", () => {
    expect(isIndexableFile(fakeTFile("Attachments/doc.pdf", "pdf"))).toBe(
      false,
    );
  });

  test("rejects a .canvas TFile", () => {
    expect(isIndexableFile(fakeTFile("map.canvas", "canvas"))).toBe(false);
  });

  test("rejects something that is not a TFile", () => {
    expect(isIndexableFile({ path: "x.md", extension: "md" })).toBe(false);
    expect(isIndexableFile(null)).toBe(false);
  });
});

describe("purgeExcludedFromStores", () => {
  const DIMS = {
    "native-minilm-l6-v2": 384,
    "embedding-gemma-300m": 768,
    "multilingual-e5-base": 768,
  } as const;

  function rec(filePath: string, dim: number): EmbeddingRecord {
    return {
      chunkId: `${filePath}#0`,
      filePath,
      offset: 0,
      heading: "Session notes",
      contentHash: "deadbeefdeadbeef",
      vector: new Float32Array(dim),
    };
  }

  /** Seed a real store for `key` with one record per path, flushed. */
  async function seed(
    registry: ReturnType<typeof createEmbeddingStoreRegistry>,
    key: keyof typeof DIMS,
    paths: string[],
  ) {
    const store = registry.storeFor(key, DIMS[key]);
    await store.init();
    await store.upsert(paths.map((p) => rec(p, DIMS[key])));
    await store.flush();
    return store;
  }

  test("purges every provider store, not only the active one", async () => {
    const mem = memAdapter();
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const native = await seed(registry, "native-minilm-l6-v2", [
      "Journal/a.md",
      "Notes/b.md",
    ]);
    const gemma = await seed(registry, "embedding-gemma-300m", [
      "Journal/c.md",
    ]);

    // A store the user switched away from still holds paths and
    // headings. "Hidden unless you switch back to last month's
    // provider" is not a policy (ADR-0020 D15).
    const removed = await purgeExcludedFromStores(
      registry,
      compilePolicy(["Journal"]),
    );

    expect(removed).toBe(2);
    expect(native.hasRecords("Journal/a.md")).toBe(false);
    expect(native.hasRecords("Notes/b.md")).toBe(true);
    expect(gemma.hasRecords("Journal/c.md")).toBe(false);
  });

  test("an empty policy purges nothing", async () => {
    const mem = memAdapter();
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);
    const native = await seed(registry, "native-minilm-l6-v2", [
      "Journal/a.md",
    ]);

    expect(await purgeExcludedFromStores(registry, EMPTY_POLICY)).toBe(0);
    expect(native.hasRecords("Journal/a.md")).toBe(true);
  });

  test("never initializes a store this vault has never used", async () => {
    const mem = memAdapter();
    const registry = createEmbeddingStoreRegistry(mem.adapter, BASE);

    expect(
      await purgeExcludedFromStores(registry, compilePolicy(["Journal"])),
    ).toBe(0);
    // A store that inits writes a dirty sentinel and a segment pair on
    // its first flush. Nothing on disk means nothing was loaded — the
    // point of probing before touching a provider's bin.
    expect(mem.files.size).toBe(0);
    expect(mem.bins.size).toBe(0);
  });
});

/**
 * R-09: a successful semantic-search wiring is logged. The line is read back
 * from an in-memory file system the logger is configured onto.
 */
describe("diagnostic log — semantic-search started", () => {
  const STARTED = "semantic-search: started";
  const { lines, has, named } = captureLogLines();

  /** A plugin whose vault adapter is in memory and whose layout never becomes ready. */
  function wiringPlugin() {
    const mem = memAdapter();
    let data: Record<string, unknown> = {};
    const plugin = mockPlugin({
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = next as Record<string, unknown>;
      },
    });
    const app = plugin.app as unknown as {
      vault: Record<string, unknown>;
      workspace: Record<string, unknown>;
    };
    app.vault.adapter = mem.adapter;
    app.vault.configDir = ".obsidian";
    app.workspace.onLayoutReady = () => {};
    return { plugin, mem };
  }

  test("a successful wiring writes `semantic-search: started` at INFO with a provider", async () => {
    const { plugin, mem } = wiringPlugin();
    const state = await wireSemanticSearch(plugin, {
      adapter: mem.adapter,
      baseDir: "/p",
    });
    expect(state).toBeDefined();
    try {
      const started = named(await lines((a) => has(a, STARTED)), STARTED);
      expect(started).toHaveLength(1);
      expect(started[0]?.level).toBe("INFO");
      expect(typeof started[0]?.fields.provider).toBe("string");
      expect((started[0]?.fields.provider as string).length).toBeGreaterThan(0);
    } finally {
      await state?.teardown();
    }
  });
});

/**
 * The lazy native indexer start and its host seams. A real model is never
 * loaded: `beforeModelLoad` throws before the pipeline factory would reach
 * the network. Tests wait on the indexer's own calls, never on a clock.
 */
describe("wireSemanticSearch — host seams", () => {
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

  function hostWithOneNote() {
    resetMockVault();
    setMockFile(
      "Notes/a.md",
      `# Title\n\n${"A sentence long enough to be worth embedding. ".repeat(8)}\n`,
    );
    const mem = memAdapter();
    let data: Record<string, unknown> = {};
    const plugin = mockPlugin({
      loadData: async () => data,
      saveData: async (next: unknown) => {
        data = next as Record<string, unknown>;
      },
    });
    return { plugin, mem };
  }

  /** Counts `start()` calls and lets a test wait for the next `stop()` to finish. */
  function watchIndexer(indexer: SemanticIndexer) {
    const start = indexer.start.bind(indexer);
    const stop = indexer.stop.bind(indexer);
    const waiting: Array<() => void> = [];
    let starts = 0;
    indexer.start = (opts) => {
      starts += 1;
      return start(opts);
    };
    indexer.stop = async () => {
      try {
        await stop();
      } finally {
        waiting.shift()?.();
      }
    };
    return {
      starts: () => starts,
      /** Resolves once the next stop() has finished and its caller has run on. */
      nextStop: () =>
        new Promise<void>((resolve) => waiting.push(resolve)).then(turn),
    };
  }

  test("a failed indexer start is retried by the next call, not latched until restart", async () => {
    const { plugin, mem } = hostWithOneNote();
    let loads = 0;
    const state = await wireSemanticSearch(plugin, {
      adapter: mem.adapter,
      baseDir: "/p",
      beforeModelLoad: async () => {
        loads += 1;
        throw new Error("offline");
      },
    });
    const watch = watchIndexer(state!.indexer!);
    try {
      // Two calls in the same tick are one start.
      const failed = watch.nextStop();
      state?.startIndexerIfNeeded?.();
      state?.startIndexerIfNeeded?.();
      expect(state?.nativeIndexBuildInProgress).toBe(true);
      await failed;
      expect(watch.starts()).toBe(1);
      expect(loads).toBe(1);
      expect(state?.nativeIndexBuildInProgress).toBe(false);

      // The failure did not disable search: the next call starts again.
      const failedAgain = watch.nextStop();
      state?.startIndexerIfNeeded?.();
      expect(state?.nativeIndexBuildInProgress).toBe(true);
      await failedAgain;
      expect(watch.starts()).toBe(2);
      expect(loads).toBe(2);
      expect(state?.nativeIndexBuildInProgress).toBe(false);
    } finally {
      await state?.teardown();
    }
  });

  test("a start that is still running is not started again", async () => {
    const { plugin, mem } = hostWithOneNote();
    let loading: (() => void) | undefined;
    const loadReached = new Promise<void>((resolve) => (loading = resolve));
    let fail: (() => void) | undefined;
    const state = await wireSemanticSearch(plugin, {
      adapter: mem.adapter,
      baseDir: "/p",
      beforeModelLoad: () => {
        loading?.();
        return new Promise<void>((_, reject) => {
          fail = () => reject(new Error("stop"));
        });
      },
    });
    const watch = watchIndexer(state!.indexer!);
    try {
      state?.startIndexerIfNeeded?.();
      await loadReached;
      state?.startIndexerIfNeeded?.();
      await turn();
      expect(watch.starts()).toBe(1);
      expect(state?.nativeIndexBuildInProgress).toBe(true);
    } finally {
      const stopped = watch.nextStop();
      fail?.();
      await stopped;
      await state?.teardown();
    }
  });

  test("the first index pass waits for the host's vault listing: a search before it prunes nothing, after it prunes what is missing", async () => {
    const { plugin, mem } = hostWithOneNote();
    const record = (filePath: string): EmbeddingRecord => ({
      chunkId: `${filePath}#0`,
      filePath,
      offset: 0,
      heading: null,
      contentHash: "h",
      vector: new Float32Array(384),
    });
    // A session that left records for a note still in the vault and one that is gone.
    const earlier = await wireSemanticSearch(plugin, {
      adapter: mem.adapter,
      baseDir: "/p",
    });
    await earlier!.store!.init();
    await earlier!.store!.upsert([record("Notes/a.md"), record("Gone/b.md")]);
    await earlier!.store!.flush();
    await earlier!.teardown();

    // The next session starts while the host is still listing the vault:
    // nothing is listed yet, and layout-ready is a barrier.
    resetMockVault();
    const barrier: Array<() => void> = [];
    (
      plugin.app as unknown as {
        workspace: { onLayoutReady: (cb: () => void) => void };
      }
    ).workspace.onLayoutReady = (cb) => {
      barrier.push(cb);
    };
    const state = await wireSemanticSearch(plugin, {
      adapter: mem.adapter,
      baseDir: "/p",
      beforeModelLoad: async () => {
        throw new Error("offline");
      },
    });
    const watch = watchIndexer(state!.indexer!);
    const store = state!.store!;
    await store.init();
    try {
      state?.startIndexerIfNeeded?.();
      await turn();
      expect(watch.starts()).toBe(0);
      expect(store.hasRecords("Notes/a.md")).toBe(true);
      expect(store.hasRecords("Gone/b.md")).toBe(true);

      // The listing completes, then the host says so.
      // Long enough to be chunked, so its embed fails offline and its
      // records stay as they were.
      setMockFile(
        "Notes/a.md",
        `# Title\n\n${"A sentence long enough to be worth embedding. ".repeat(8)}\n`,
      );
      const finished = watch.nextStop();
      for (const cb of barrier.splice(0)) cb();
      await finished;
      expect(watch.starts()).toBe(1);
      expect(store.hasRecords("Notes/a.md")).toBe(true);
      expect(store.hasRecords("Gone/b.md")).toBe(false);
    } finally {
      await state?.teardown();
    }
  });

  test("a teardown before the host is ready keeps the pending first pass from starting", async () => {
    const { plugin, mem } = hostWithOneNote();
    const barrier: Array<() => void> = [];
    (
      plugin.app as unknown as {
        workspace: { onLayoutReady: (cb: () => void) => void };
      }
    ).workspace.onLayoutReady = (cb) => {
      barrier.push(cb);
    };
    const state = await wireSemanticSearch(plugin, {
      adapter: mem.adapter,
      baseDir: "/p",
    });
    const watch = watchIndexer(state!.indexer!);
    state?.startIndexerIfNeeded?.();
    await turn();
    await state?.teardown();
    for (const cb of barrier.splice(0)) cb();
    await turn();
    expect(watch.starts()).toBe(0);
  });

  describe("with an indexer gate", () => {
    const STALE_META = "/p/embeddings/native-minilm-l6-v2/embeddings.meta.json";

    test("the stale-store wipe waits for the gate, and an ungated host still wipes during wiring", async () => {
      const refused = hostWithOneNote();
      seedStore(refused.mem, "native-minilm-l6-v2", FORMAT_VERSION - 1, 3);
      let open = false;
      const messages: string[] = [];
      const state = await wireSemanticSearch(refused.plugin, {
        adapter: refused.mem.adapter,
        baseDir: "/p",
        notify: (m) => messages.push(m),
        beforeModelLoad: async () => {
          throw new Error("offline");
        },
        indexerGate: () =>
          open ? { ok: true } : { ok: false, reason: "owned elsewhere" },
      });
      const watch = watchIndexer(state!.indexer!);
      try {
        // Wiring itself asked the gate (the upgrade rebuild) and was refused.
        state?.startIndexerIfNeeded?.();
        await turn();
        expect(state?.unavailableReason).toBe("owned elsewhere");
        expect(refused.mem.removed()).toEqual([]);
        expect(refused.mem.files.has(STALE_META)).toBe(true);
        expect(messages).toEqual([]);

        // Allowed: the wipe runs, then the notice, then the indexer starts.
        open = true;
        const finished = watch.nextStop();
        state?.startIndexerIfNeeded?.();
        await finished;
        expect(refused.mem.files.has(STALE_META)).toBe(false);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain("index format upgraded");
        expect(watch.starts()).toBe(1);
      } finally {
        await state?.teardown();
      }

      const ungated = hostWithOneNote();
      seedStore(ungated.mem, "native-minilm-l6-v2", FORMAT_VERSION - 1, 3);
      const plain = await wireSemanticSearch(ungated.plugin, {
        adapter: ungated.mem.adapter,
        baseDir: "/p",
      });
      try {
        expect(ungated.mem.files.has(STALE_META)).toBe(false);
      } finally {
        await plain?.teardown();
      }
    });

    test("the v1 flat-store migration also waits for the gate", async () => {
      const { plugin, mem } = hostWithOneNote();
      mem.bins.set("/p/embeddings.bin", new ArrayBuffer(8));
      let open = false;
      const state = await wireSemanticSearch(plugin, {
        adapter: mem.adapter,
        baseDir: "/p",
        beforeModelLoad: async () => {
          throw new Error("offline");
        },
        indexerGate: () =>
          open ? { ok: true } : { ok: false, reason: "owned elsewhere" },
      });
      const watch = watchIndexer(state!.indexer!);
      try {
        expect(mem.bins.has("/p/embeddings.bin")).toBe(true);
        state?.startIndexerIfNeeded?.();
        await turn();
        expect(mem.bins.has("/p/embeddings.bin")).toBe(true);

        open = true;
        const finished = watch.nextStop();
        state?.startIndexerIfNeeded?.();
        await finished;
        expect(mem.bins.has("/p/embeddings.bin")).toBe(false);
        expect(
          mem.bins.has("/p/embeddings/native-minilm-l6-v2/embeddings.bin"),
        ).toBe(true);
      } finally {
        await state?.teardown();
      }
    });
  });

  describe("with an asynchronous indexer gate", () => {
    const STALE_META = "/p/embeddings/native-minilm-l6-v2/embeddings.meta.json";

    function deferredGate() {
      let answer!: (r: { ok: true } | { ok: false; reason: string }) => void;
      const answered = new Promise<
        { ok: true } | { ok: false; reason: string }
      >((resolve) => (answer = resolve));
      let asks = 0;
      return {
        gate: () => {
          asks += 1;
          return answered;
        },
        answer,
        asks: () => asks,
      };
    }

    test("searches arriving while the gate decides share one answer and start the indexer once", async () => {
      const { plugin, mem } = hostWithOneNote();
      const g = deferredGate();
      const state = await wireSemanticSearch(plugin, {
        adapter: mem.adapter,
        baseDir: "/p",
        beforeModelLoad: async () => {
          throw new Error("offline");
        },
        indexerGate: g.gate,
      });
      const watch = watchIndexer(state!.indexer!);
      try {
        const first = state!.startIndexerIfNeeded!();
        const second = state!.startIndexerIfNeeded!();
        expect(first).toBeInstanceOf(Promise);
        expect(second).toBe(first);
        expect(g.asks()).toBe(1);
        expect(state?.nativeIndexBuildInProgress).toBeFalsy();

        const finished = watch.nextStop();
        g.answer({ ok: true });
        await first;
        await finished;
        expect(watch.starts()).toBe(1);
      } finally {
        await state?.teardown();
      }
    });

    test("a refusal is reported once the gate answers", async () => {
      const { plugin, mem } = hostWithOneNote();
      const g = deferredGate();
      const state = await wireSemanticSearch(plugin, {
        adapter: mem.adapter,
        baseDir: "/p",
        indexerGate: g.gate,
      });
      try {
        const pending = state!.startIndexerIfNeeded!();
        expect(state?.unavailableReason).toBeUndefined();
        g.answer({ ok: false, reason: "owned elsewhere" });
        await pending;
        expect(state?.unavailableReason).toBe("owned elsewhere");
        expect(state?.nativeIndexBuildInProgress).toBeFalsy();
      } finally {
        await state?.teardown();
      }
    });

    test("an answer that arrives after teardown starts nothing and leaves the stale store alone", async () => {
      const { plugin, mem } = hostWithOneNote();
      seedStore(mem, "native-minilm-l6-v2", FORMAT_VERSION - 1, 3);
      const g = deferredGate();
      const state = await wireSemanticSearch(plugin, {
        adapter: mem.adapter,
        baseDir: "/p",
        indexerGate: g.gate,
      });
      const watch = watchIndexer(state!.indexer!);
      const pending = state!.startIndexerIfNeeded!();
      await state?.teardown();
      g.answer({ ok: true });
      await pending;
      await turn();
      expect(watch.starts()).toBe(0);
      expect(mem.removed()).toEqual([]);
      expect(mem.files.has(STALE_META)).toBe(true);
      // After teardown a new search does not even ask the gate.
      await state!.startIndexerIfNeeded!();
      expect(g.asks()).toBe(1);
    });
  });

  describe("teardown and the store preparation", () => {
    const STALE_META = "/p/embeddings/native-minilm-l6-v2/embeddings.meta.json";

    test("teardown waits for a paused wipe, and no store write follows it", async () => {
      const { plugin, mem } = hostWithOneNote();
      seedStore(mem, "native-minilm-l6-v2", FORMAT_VERSION - 1, 3);
      // The first removal parks until released; every removal records
      // whether teardown had already returned.
      let tornDown = false;
      let lateWrites = 0;
      let parked!: () => void;
      const wipeReached = new Promise<void>((resolve) => (parked = resolve));
      let resume!: () => void;
      const resumed = new Promise<void>((resolve) => (resume = resolve));
      const remove = mem.adapter.remove.bind(mem.adapter);
      let first = true;
      mem.adapter.remove = async (p) => {
        if (tornDown) lateWrites += 1;
        if (first) {
          first = false;
          parked();
          await resumed;
        }
        if (tornDown) lateWrites += 1;
        await remove(p);
      };
      const state = await wireSemanticSearch(plugin, {
        adapter: mem.adapter,
        baseDir: "/p",
        beforeModelLoad: async () => {
          throw new Error("offline");
        },
        indexerGate: () => ({ ok: true }),
      });
      state?.startIndexerIfNeeded?.();
      await wipeReached;

      let settled = false;
      const tearing = state!.teardown().then(() => {
        settled = true;
        tornDown = true;
      });
      for (let i = 0; i < 5; i++) await turn();
      expect(settled).toBe(false);

      resume();
      await tearing;
      // Teardown returned only after the whole wipe.
      expect(mem.files.has(STALE_META)).toBe(false);
      const removedAtReturn = mem.removed().length;
      for (let i = 0; i < 5; i++) await turn();
      expect(mem.removed()).toHaveLength(removedAtReturn);
      expect(lateWrites).toBe(0);
    });

    test("teardown still finishes when the preparation fails", async () => {
      const { plugin, mem } = hostWithOneNote();
      seedStore(mem, "native-minilm-l6-v2", FORMAT_VERSION - 1, 3);
      mem.adapter.remove = async () => {
        throw new Error("disk gone");
      };
      const state = await wireSemanticSearch(plugin, {
        adapter: mem.adapter,
        baseDir: "/p",
        beforeModelLoad: async () => {
          throw new Error("offline");
        },
        indexerGate: () => ({ ok: true }),
      });
      state?.startIndexerIfNeeded?.();
      await turn();
      await state!.teardown();
    });
  });

  test("vault rename events reach the indexer for files only, with the old path", async () => {
    const { plugin, mem } = hostWithOneNote();
    const state = await wireSemanticSearch(plugin, {
      adapter: mem.adapter,
      baseDir: "/p",
    });
    const fakeTFile = (path: string, extension: string): TFile => {
      const f = Object.create(TFile.prototype) as TFile;
      Object.assign(f, { path, extension });
      return f;
    };
    try {
      const indexer = state!.indexer!;
      await indexer.start({ initialRebuild: false });

      // A folder (not a TFile) is ignored: its files get their own events.
      fireMockVaultEvent("rename", { path: "moved" }, "dir");
      expect(indexer.pending()).toBe(0);

      // A markdown file schedules both its old and its new path.
      fireMockVaultEvent("rename", fakeTFile("new.md", "md"), "old.md");
      expect(indexer.pending()).toBe(2);
    } finally {
      // Started directly, so teardown() would not stop it.
      await state?.indexer?.stop();
      await state?.teardown();
    }
  });

  test("vault events never read the request-scoped policy", async () => {
    // Reading AsyncLocalStorage inside a vault rename handler crashed
    // Obsidian's renderer, so the indexer reads the vault-wide policy.
    const { plugin, mem } = hostWithOneNote();
    const state = await wireSemanticSearch(plugin, {
      adapter: mem.adapter,
      baseDir: "/p",
    });
    const fakeTFile = (path: string): TFile => {
      const f = Object.create(TFile.prototype) as TFile;
      Object.assign(f, { path, extension: "md" });
      return f;
    };
    const getStore = spyOn(AsyncLocalStorage.prototype, "getStore");
    try {
      const indexer = state!.indexer!;
      await indexer.start({ initialRebuild: false });
      const calls = getStore.mock.calls.length;
      // A request scope that excludes Notes/ must not reach the indexer:
      // the vault-wide policy, empty here, decides.
      pathPolicyFor(plugin).runWith(compilePolicy(["Notes"]), () => {
        fireMockVaultEvent("rename", fakeTFile("Notes/b.md"), "Notes/a.md");
        fireMockVaultEvent("modify", fakeTFile("Notes/c.md"));
      });
      expect(getStore.mock.calls.length).toBe(calls);
      expect(indexer.pending()).toBe(3);
    } finally {
      getStore.mockRestore();
      await state?.indexer?.stop();
      await state?.teardown();
    }
  });

  test("the index lives under baseDir on the injected adapter", async () => {
    const { plugin, mem } = hostWithOneNote();
    seedStore(mem, "native-minilm-l6-v2", FORMAT_VERSION, 3);
    const state = await wireSemanticSearch(plugin, {
      adapter: mem.adapter,
      baseDir: "/p",
    });
    try {
      expect(state?.probedCounts?.["native-minilm-l6-v2"]).toBe(3);
    } finally {
      await state?.teardown();
    }
  });

  test("a stale index is reported through notify, when there is one to tell", async () => {
    const { plugin, mem } = hostWithOneNote();
    seedStore(mem, "native-minilm-l6-v2", 0, 3);
    const ready: Array<() => void> = [];
    (
      plugin.app as unknown as {
        workspace: { onLayoutReady: (cb: () => void) => void };
      }
    ).workspace.onLayoutReady = (cb) => {
      ready.push(cb);
    };
    const messages: string[] = [];
    const state = await wireSemanticSearch(plugin, {
      adapter: mem.adapter,
      baseDir: "/p",
      notify: (m) => messages.push(m),
    });
    try {
      // The notice first, then the automatic rebuild; only the notice runs.
      expect(ready).toHaveLength(2);
      ready[0]();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("index format upgraded");
    } finally {
      await state?.teardown();
    }

    // Without notify the same callback is silent.
    const quiet = hostWithOneNote();
    seedStore(quiet.mem, "native-minilm-l6-v2", 0, 3);
    const callbacks: Array<() => void> = [];
    (
      quiet.plugin.app as unknown as {
        workspace: { onLayoutReady: (cb: () => void) => void };
      }
    ).workspace.onLayoutReady = (cb) => {
      callbacks.push(cb);
    };
    const quietState = await wireSemanticSearch(quiet.plugin, {
      adapter: quiet.mem.adapter,
      baseDir: "/p",
    });
    try {
      expect(() => callbacks[0]()).not.toThrow();
    } finally {
      await quietState?.teardown();
    }
  });
});
