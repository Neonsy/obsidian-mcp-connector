/**
 * Semantic search for the headless server: the desktop feature, wired to a
 * plain cache directory instead of the vault's plugin folder.
 *
 * Nothing is fetched at startup. The first `search_vault_smart` call
 * starts the indexer, which loads the model, which first downloads the
 * ONNX runtime files and then the model weights. Until the index is
 * ready that call returns the usual `index_building` error with progress.
 *
 * Cache layout, under $XDG_CACHE_HOME or ~/.cache:
 *   obsidian-mcp-connector/models/              model weights, shared
 *   obsidian-mcp-connector/ort-<version>/       ONNX runtime files, shared
 *   obsidian-mcp-connector/<vault>-<hash>/embeddings/   this vault's index
 *
 * One process at a time writes a vault's index (see cacheLock.ts). The lock
 * is taken when the first search would start the indexer. If another
 * process holds it, `search_vault_smart` stays registered and answers with
 * `semantic_search_unavailable`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { env as hfEnv } from "@huggingface/transformers";
import { setWasmPaths } from "$/features/semantic-search/services/onnxEnv";
import { wireSemanticSearch } from "$/features/semantic-search/services/productionWiring";
import type { SemanticSearchState } from "$/features/semantic-search/setup";
import type { SemanticHost } from "$/features/semantic-search/types";
import { logger } from "$/shared/logger";
import { withHeadersTimeout } from "./fetchTimeout";
import { createCacheLock, lockAddress, type CacheLockDeps } from "./cacheLock";
import { defaultCachePath, defaultCacheRoot } from "./hostData";
import { nodeFsAdapter } from "./nodeFsAdapter";
import { ensureOrtAssets } from "./ortAssets";

/** Quantized weights: 23 MB against 90 MB, and faster on a CPU. */
const NATIVE_DTYPE = "q8";
/** A request that gets no response headers in this long is abandoned. */
const HEADERS_TIMEOUT_MS = 30_000;
/**
 * Chunks per inference call. Inference runs on the main thread, so a
 * batch stalls the event loop for as long as it takes: small batches
 * keep the server answering other tool calls while it indexes.
 */
const EMBED_BATCH_SIZE = 1;

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * Wire semantic search for the vault at `vaultRealPath`. Resolves with
 * the state to hand to the tool (`host.semanticSearchState`), or
 * undefined when the feature failed to set up.
 */
export async function wireHeadlessSemanticSearch(
  host: SemanticHost,
  vaultRealPath: string,
  environment: Record<string, string | undefined> = process.env,
  lockDeps?: CacheLockDeps,
): Promise<SemanticSearchState | undefined> {
  const root = defaultCacheRoot(environment);
  const vaultDir = defaultCachePath(vaultRealPath, environment);
  await fs.mkdir(vaultDir, { recursive: true, mode: 0o700 });
  // The index holds note paths and headings in clear text.
  await fs.chmod(root, 0o700);

  // transformers.js falls back to "/.cache" without this, and would look
  // for models under a local path before the hub.
  hfEnv.cacheDir = path.join(root, "models");
  hfEnv.allowLocalModels = false;
  hfEnv.fetch = withHeadersTimeout(hfEnv.fetch, HEADERS_TIMEOUT_MS);

  let runtime: Promise<void> | undefined;
  const prepareRuntime = (): Promise<void> => {
    runtime ??= ensureOrtAssets(root, {
      // `init` carries the timeout's AbortSignal: dropping it would leave
      // a request that never answers hanging for good.
      fetch: withHeadersTimeout(
        (url, init) => fetch(url, init),
        HEADERS_TIMEOUT_MS,
      ),
    }).then(
      ({ prefix }) => {
        setWasmPaths(prefix);
      },
      (err: unknown) => {
        // The next attempt starts over rather than replaying the failure.
        runtime = undefined;
        throw err;
      },
    );
    return runtime;
  };

  const lock = createCacheLock(lockAddress(root, vaultDir), lockDeps);
  const state = await wireSemanticSearch(host, {
    indexerGate: async () => {
      const got = await lock.acquire();
      if (got.ok) return { ok: true };
      return {
        ok: false,
        reason: got.error
          ? `Semantic search is unavailable: the index lock for this vault could not be taken (${got.error}).`
          : "Semantic search is unavailable: another obsidian-mcp-headless process is using the semantic index for this vault. Use that server, or stop it and retry.",
      };
    },
    adapter: nodeFsAdapter(vaultDir),
    baseDir: "",
    notify: (message) => logger.info(message),
    nativeDtype: NATIVE_DTYPE,
    beforeModelLoad: prepareRuntime,
    embedBatching: {
      size: EMBED_BATCH_SIZE,
      yieldBetweenBatches: yieldToEventLoop,
    },
  });
  if (!state) {
    await lock.release();
    return undefined;
  }
  const teardown = state.teardown;
  state.teardown = async () => {
    try {
      await teardown();
    } finally {
      await lock.release();
    }
  };
  return state;
}
