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
   Headless registers the shared set alone: 42 tools plus the three adaptive-loading meta-tools.
   Excluded in v1: `rename_vault_file`, `search_files_by_name`, `fetch`, daily and periodic notes, `search_vault_smart`, and every workspace, active-file, command, Dataview, Templater and bookmark tool.
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

## Consequences

- Tool names and response shapes stay identical, so client integrations carry over.
- The parser and the link resolver are approximations of Obsidian's.
  Differences show up in edge cases such as setext headings, footnotes and unusual tag forms, and the tests pin the behaviour the tools rely on.
- The "Excluded files" setting has no equivalent, and `get_server_info` reports a loopback endpoint, which is correct because headless binds `127.0.0.1` only.
- Semantic search is not part of v1 and is planned.
- The shared seams add a type parameter to the composition root and the transport setup, and the desktop tests pass the registrar explicitly.
- The `tools/list` order on desktop now lists the shared tools first and the desktop-only tools after them.
- Rescans, watcher reconciles and own writes share one serial index queue, so they never interleave, and a write still returns only after the index reflects it.
  While external changes are landing, a read can see the index partway through a rescan, for example a note listed as orphaned before its incoming links are resolved, until the rescan finishes.
- Creating or deleting a note recomputes every link in the vault, so its cost grows with the vault's link count: about 70 ms at 5,000 notes and about 0.3 s at 20,000 notes in our measurements, while property edits stay at a few milliseconds.
  Incremental link updates are the next step if large vaults need them.
