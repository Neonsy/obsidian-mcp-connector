# ADR-0031: Headless mode: the vault tools served from a folder, without Obsidian

- **Status:** Accepted and implemented
- **Date:** 2026-10-15
- **Scope:** A standalone Node process that serves a subset of the MCP vault tools from a vault directory, its launch modes, its distribution and the seams in the shared code it needed
- **Relates to:** [ADR-0016](/docs/architecture/ADR-0016-omc-008-adopt-mcp-spec-2026-07-28.md) (era routing, reused unchanged), [ADR-0020](/docs/architecture/ADR-0020-omc-040-vault-folder-exclusion.md) (the guarded `App` wraps the headless app too), [ADR-0014](/docs/architecture/ADR-0014-per-client-tool-profiles.md) (token policy, reused)

## Context

The connector runs inside Obsidian's renderer, so a Linux server with no desktop cannot use it.
Discussion #608 asks for the same tools against a plain folder of notes.
Headless Obsidian MCP servers exist and are launched by the client over stdio with only a vault path, so that is the bar for setup.

The tools never touch Obsidian directly.
They call a small surface of `App` (`vault`, `metadataCache`, `fileManager`, `workspace`) and import `TFile` for `instanceof` checks.
That surface can be implemented over a directory, and the existing composition root, token store and both protocol eras can serve it unchanged.
What stood in the way was structural: the composition root, the transport setup and the tool registration required the Obsidian plugin class, a few modules reached Svelte and `Modal` through feature barrels, and two timer sites called `window.setTimeout`.

## Decision

1. **One shared tool set, registered twice.**
   `registerVaultTools` holds the tools that need only a vault-shaped `App` and a settings host.
   The desktop `registerTools` calls it and then registers the desktop-only tools, so the desktop tool set is unchanged.
   Headless registers the shared set alone: 45 tools plus the three adaptive-loading meta-tools.
   `search_vault_smart` is part of the shared set behind an option: the desktop passes it, and headless passes it unless `--no-semantic` is given (see decision 9).
   `rename_vault_file` and `search_files_by_name` are part of that set and run their desktop code unchanged (see decision 8).
   Excluded in v1: `fetch`, daily and periodic notes, and every workspace, active-file, command, Dataview, Templater and bookmark tool.
2. **Structural host, injected registrar.**
   `composeToolRegistry`, `createMcpService` and the transport setup take a registrar and a host with `app`, `manifest`, `loadData` and `saveData` instead of the plugin class.
   The server `instructions` text is a parameter, so headless does not advertise tools it lacks.
   The two `window.setTimeout` sites use `globalThis`, with no `window` polyfill.
   The headless import graph reaches services directly and never a barrel that exports a Svelte component.
3. **A directory-backed `App`.**
   `HeadlessApp` implements the retained subset of the `App` surface over a file index, and `createGuardedApp` wraps it unchanged.
   Own writes update the index and the metadata before the promise resolves.
   Writes to one path run in a per-path queue, read fresh and land atomically (temp file in the same directory, then rename).
   An edit keeps the file's permission bits but replaces the file, so its birth time (the created time `get_file_info` reports) resets and hard links to it are not preserved.
   The `obsidian` import is aliased at build time to a runtime shim that exports only what the retained graph needs.
4. **Confinement.**
   Every path is normalised (no `..`, absolute paths, NUL bytes or dot-segments) and joined on the realpath of the vault root, taken once at startup.
   Symlinks inside the vault are ignored: they are not indexed, and a path through one is refused.
   Dot-folders are not indexed, read or written.
   Host paths are stripped from error messages.
5. **Own metadata parser.**
   A line-oriented parser produces the `CachedMetadata` fields the tools read, and a link resolver reproduces `getFirstLinkpathDest` and `resolveSubpath`.
   Any change to the file set recomputes every file's link entries, so a created target resolves an unchanged source.
   A non-recursive `fs.watch` on each visible folder (none on dot-folders or symlinks) with a per-path debounce reconciles external edits, and a folder change or a watcher error closes the watches, rewatches the folders and rescans. The watcher opens before the initial scan and holds its events until the scan is done, then reconciles them, so an edit made during startup is not lost.
6. **Two launch modes.**
   Stdio is the default: `obsidian-mcp-headless /path/to/vault` (or `OBSIDIAN_VAULT`), spoken by the client that spawned it.
   There is no token, so the session is served under a stored policy with the full tool profile.
   `--http` is the service mode: loopback only, bearer token from the existing token store, state file outside the vault with mode `0600`, `--print-token` to read the token.
   The `yaml` package, used to parse and write frontmatter, is the only new dependency.
7. **Distribution is one file.**
   `bun run build:headless` bundles everything into `packages/obsidian-plugin/dist/headless/obsidian-mcp-headless.js` as CommonJS with a `node` shebang and the executable bit, so it runs as `node obsidian-mcp-headless.js` and as an extensionless copy on `PATH` on Node 24.11 or newer, the first Node 24 LTS release, and the release workflow attaches it to each release.
   Nothing is published to a package registry.

8. **File-name search and rename reuse the desktop tools.**
   `search_files_by_name` imports `prepareFuzzySearch`, `sortSearchResults` and `parseFrontMatterAliases` from `obsidian`, and the shim now provides them.
   Obsidian's scoring is not public, so the scorer is our own: in-order characters, scored by the cheapest alignment, where contiguous runs and word starts cost less and an earlier or tighter text ranks higher.
   The query is folded one code point at a time like each name, so a final capital sigma matches the same name it came from.
   Scores are at most 0 with 0 the best, and `SearchResult` and match ranges follow the public typings.
   The tool description says the scoring is Obsidian's own on desktop only.
   `rename_vault_file` calls `fileManager.renameFile`, which headless implements in two steps.
   The vault moves the entry on disk and in the index as one step of the serial index queue.
   A rename takes the whole vault: it waits for every write in flight (property writes, `process`, `modify`) and writes that arrive meanwhile wait for it, then queue under the path the file has by then.
   So a writer never holds text read from a path that has moved, and a link rewrite is never undone by a stale write.
   Before it picks the notes that link to the moved file, the rename applies the file events the watcher is still holding for its debounce.
   A file is first renamed to a unique hidden name that the move owns, which captures exactly the entry being moved, so an atomic save by another program that lands at the old name afterwards is never deleted.
   The owned file is then hard-linked to the new name (which fails atomically if the name is taken) and the owned name is removed, so a file that appeared behind the index is never replaced.
   If the link fails the file is put back with the same exclusive link, and if that fails too the owned file stays and the error (code `ESTRANDED`, which the trash loop never mistakes for a taken name) names it.
   Once the new name exists the move has succeeded and that name is never unlinked again, because by then it may be a different file that another program saved there.
   If the owned name then cannot be removed it stays hidden, is never indexed, and the error says the move succeeded and names it so it can be deleted.
   Where hard links are not available it moves onto an exclusively created empty placeholder instead, and there a save landing at the destination in the instant before the move can be replaced.
   A folder is renamed once its destination is seen to be absent, without creating the destination first (Windows refuses that), so on POSIX the only entry a racing writer could lose is an empty directory.
   A case-only rename (`Note.md` to `note.md`) on a case-insensitive filesystem needs no special case for a file, which has left its old name before it is linked, and is detected by comparing device and inode for a folder and done through a temporary hidden name.
   The same path rules as every write apply to both ends (no `..`, dot-folders, symlinks, root or control characters, which could otherwise inject YAML or markdown structure into a link).
   A rename also refuses a destination when any segment of its path (the final name or a folder above it) contains any of `[ ] | # ^`, as desktop Obsidian does, or a backtick, or starts or ends with whitespace, because a wikilink cannot escape anything: a backtick can pair with a later one into a code span that hides the link, and whitespace at either end is trimmed from every link.
   Only the destination is checked, so existing files with those characters stay readable and can be renamed away.
   The index keeps the same `TFile` and `TFolder` objects with their new paths, moves each cache with its file (a file that becomes a note is parsed from disk, and one that stops being a note loses its cache), keeps the signature the file had before the move so an edit made outside around the move is found by the next reconcile, recomputes link resolution once and then emits `rename` with the old path for the entry and everything below it.
   Then every note that links to a moved file, and every moved note, is rewritten through the normal per-path write, so each write is atomic and updates the index.
   A link is rewritten when its text no longer resolves to its old target after the move, judged by two link resolvers built over the file set before and after.
   So `[[note]]` survives a folder rename untouched, and a relative link in a moved note is recomputed.
   The new text keeps the link's style: relative stays relative, a bare name stays the shortest form (the name when exactly one file has it, else the full path), a full path stays a full path, and `.md`, aliases, subpaths, embed marks, link text, titles, angle brackets and URL encoding carry over.
   A written markdown destination percent-encodes (as UTF-8) every character that is not a letter, mark, number or one of `/ . _ ~ -`, except that an ASCII space stays raw inside `<...>`, so no name can end the destination, start a subpath, read as a URL scheme (`RFC: Auth.md`), open a code span or count as whitespace, and desktop Obsidian decodes it back to the same path.
   Positions come from the metadata cache.
   A cache is used only when it was parsed from exactly the text being edited, otherwise the note is parsed again, so an edit made behind the index is not corrupted.
   Frontmatter links have no position, so the frontmatter is parsed as YAML and each string value (never a key) that holds a link is replaced through its source range, spelled in its own quoting style or in a quoted style that can hold the new text.
   The rest of the block stays byte for byte as it was, and edits that would overlap fail the note instead of corrupting it.
   Each new link text is parsed back and resolved before it is written, and a link that no spelling leads back to its target (such as a relative link to a file left in a folder named `a#b`) is left as it was and named in the error below.
   If the move succeeds and a note then fails to rewrite, the move stands and the error names the notes left out of date.
   Limits: links in canvases and `.base` files are not rewritten, the link style comes from each link and not from `.obsidian/app.json` (dot-folders are never read), a link that did not resolve before the move is left as written, and on a filesystem without hard links a save landing at the destination in the instant before the move can be replaced.
   There is no transaction across the move and the rewrites, and a change the operating system has not yet reported to the watcher when the rename starts is not seen.

9. **Semantic search runs on the desktop feature code, with host seams.**
   The tool, the chunker, the store and the indexer are the desktop ones.
   `wireSemanticSearch(host, deps)` takes what differs between hosts: the store adapter, the folder that holds `embeddings/`, a notice callback, an optional dtype for the native model, a hook that runs before the model's first load, and an optional embed batching.
   The desktop passes the vault adapter, its plugin folder and `Notice`, and nothing else, so its behavior does not change.
   Headless passes a Node file adapter over a cache folder outside the vault and the options below.
   The feature's public file was split so the wiring no longer reaches a Svelte component: `setup.ts` holds the logic, and `index.ts` re-exports it with the settings component for the desktop.
   `SemanticHost` (a structural type) replaces the plugin class in the feature's signatures.
   - **Lazy, on by default.** Nothing is fetched at startup. The first `search_vault_smart` call starts the indexer, which loads the model, which first fetches the ONNX runtime files and then the model weights. The call returns the existing `index_building` error until the index is ready. `--no-semantic` leaves the tool unregistered.
   - **Same model, q8 weights.** The native model is the desktop default, `Xenova/all-MiniLM-L6-v2`, loaded at dtype `q8` in headless: 23 MB against 90 MB at full precision, and about 1.6 times faster on a CPU in the feasibility run. The desktop dtype is unchanged. The desktop does not pass a dtype, so transformers.js loads the WASM backend's default.
   - **Cache layout.** `$XDG_CACHE_HOME` or `~/.cache`, then `obsidian-mcp-connector/`: `models/` and `ort-<version>/` shared across vaults, and `<vault name>-<8 hex of the realpath hash>/embeddings/` per vault, named like the HTTP state file. Folders are `0700` and files `0600` because the store keeps paths and headings in clear text. The adapter writes through a temporary file and a rename, and refuses a path that leaves its folder. The cache folder is trusted as the user's own, since anyone who can write there can already change their shell startup files.
   - **ONNX runtime files are pinned.** Node's `import()` accepts only `file:` and `data:` URLs, so onnxruntime-web cannot load its glue script from the CDN address the desktop uses. Headless fetches `ort-wasm-simd-threaded.mjs` and `.wasm` of the pinned onnxruntime-web version from the same jsDelivr URL, once, verifies a SHA-256 for each before anything is written, writes atomically, and points ORT's `wasmPaths` at the folder. A cached file is re-verified on use. A test compares the pins with the installed package. The model is not pinned to a revision, as on the desktop, and `HF_TOKEN` handling is transformers.js's own.
   - **Bundle.** `onnxruntime-node` cannot live in one file, so every ONNX import in the headless bundle resolves to a small shim over the CPU build of onnxruntime-web (`ort.wasm.min.js`). The shim reads a model path into bytes first, because ORT-web would fetch a string as a URL. `sharp` is stubbed. The two `import.meta` tests in transformers.js's Node build are rewritten at build time, and the build still fails if any `import.meta` remains. The bundle grows by about 0.6 MB.
   - **Environment checks.** Node 24 defines `navigator` but has no Cache API, so the browser cache is chosen by `caches`, not `navigator`. The transformers.js cache folder is set explicitly, because its default is `/.cache`. Model requests that get no response headers within 30 seconds are abandoned (a header deadline only, never a total-download limit).
   - **Event loop.** Inference runs on the main thread and one CPU thread, so a batch blocks the loop for as long as it takes. Headless embeds one chunk per call and yields to the event loop (`setImmediate`) between calls. There is no worker. The desktop keeps its batches of 8.
   - **A failed first start is retried.** `startIndexerIfNeeded` used to latch for the session, so an offline first run disabled search until restart. A failed start now stops the indexer, keeps what was indexed and clears the latch, and the next call tries again, with no timer or backoff. This also fixes the desktop.
   - **Settings.** Semantic search has its own in-memory settings in headless, so the HTTP state file still holds only the token. The defaults apply: provider `auto`, which resolves to the native one, and live indexing. The one slice it reads from the transport's host is `mcpTools`, so the folder exclusions that hide notes from the tools also keep them out of the index.
   - **One writer per index.** The first search takes a lock the operating system holds for the process: a listening local socket named after the vault's cache folder (an abstract socket on Linux, a named pipe on Windows, a socket file in the cache root elsewhere), unref'd so it never keeps the process alive. A second process finds the name in use, and the kernel frees it when the holder dies, so there is no stale lock to detect. The lock is released on teardown, after the indexer and any pending migration or wipe have finished, so a successor never meets a late write. Nothing in the index folder is written or wiped, including the format-upgrade cleanup, before the lock is held. While another process holds it, `search_vault_smart` stays registered and returns `semantic_search_unavailable`, which tells the client more than a missing tool would. On macOS a killed holder leaves its socket file, which the next server removes after a refused connection, and two servers doing that at the same instant is a residual race.
   - **Bounded shutdown.** Cleanup waits on the indexer, which can be stuck in a stalled download, so SIGINT, SIGTERM and the end of stdin give it 5 seconds and then exit, with a line on stderr when the bound fired.
   - **Stale entries are pruned.** Once the host reports the vault listing ready, a full pass of the shared indexer drops stored paths that are no longer in the vault, so a file renamed or deleted while no server ran stops being returned. Files that still exist but are excluded stay, as before. This also changes the desktop.
   - **Limits.** CPU only. The desktop's other providers and its settings screen do not exist here. An index is not shared with the plugin, and q8 scores differ slightly from the plugin's native scores. Peak memory is about 0.5 GB with the model loaded. Indexing uses one core for as long as it runs, and a call to another tool can wait for the chunk being embedded, which in our measurement on a 50-note vault was up to about 0.4 s while indexing and 0.6 s once while the model loaded.

## Consequences

- Tool names and response shapes stay identical, so client integrations carry over.
- The parser and the link resolver are approximations of Obsidian's.
  Differences show up in edge cases such as setext headings, footnotes and unusual tag forms, and the tests pin the behaviour the tools rely on.
- The "Excluded files" setting has no equivalent (so `search_files_by_name` omits nothing), and `get_server_info` reports a loopback endpoint, which is correct because headless binds `127.0.0.1` only.
- Semantic search is part of the shared set (decision 9). Its limits are listed there.
- The shared seams add a type parameter to the composition root and the transport setup, and the desktop tests pass the registrar explicitly.
- The `tools/list` order on desktop now lists the shared tools first and the desktop-only tools after them, and `search_vault_smart` sits among the shared ones.
- Rescans, watcher reconciles and own writes share one serial index queue, so they never interleave, and a write still returns only after the index reflects it.
  While external changes are landing, a read can see the index partway through a rescan, for example a note listed as orphaned before its incoming links are resolved, until the rescan finishes.
- Creating or deleting a note recomputes every link in the vault, so its cost grows with the vault's link count: about 70 ms at 5,000 notes and about 0.3 s at 20,000 notes in our measurements, while property edits stay at a few milliseconds.
  Incremental link updates are the next step if large vaults need them.
