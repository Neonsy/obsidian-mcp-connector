/**
 * Server `instructions` for the headless server. Same conventions as the
 * desktop text, without the tools it does not register (periodic notes,
 * Dataview, Templater). Kept under 512 characters like the desktop text.
 */
export const HEADLESS_INSTRUCTIONS = [
  "Obsidian vault tools served from a vault folder: read, search, create and",
  "edit notes, frontmatter, tags, links, headings, blocks, tasks, canvases.",
  "Search it before answering about the user's notes.",
  "Conventions:",
  "- Paths are vault-relative with extension ('Projects/idea.md'), no '/'",
  "  or '~' prefix.",
  "- Lines are 0-indexed; startLine/endLine ranges are inclusive.",
  "- Failures are results with isError: true and JSON text",
  "  { error, errorCode, ... }; branch on errorCode (snake_case, e.g.",
  "  file_not_found).",
].join("\n");
