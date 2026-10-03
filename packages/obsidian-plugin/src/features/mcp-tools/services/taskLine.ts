/**
 * One markdown task line, as Obsidian's `ListItemCache` sees it: a list
 * marker, a `[x]` box with a single status character, then the text.
 * `' '` is the only "open" status; any other character counts as done,
 * which is the rule the metadata cache applies (`ListItemCache.task`).
 */
export type TaskLine = {
  /** Leading whitespace plus the list marker, e.g. `"  - "` or `"1. "`. */
  prefix: string;
  /** The single character inside the brackets. */
  marker: string;
  /** Everything after `[x] `, untrimmed on the right. */
  text: string;
  /**
   * Set to `"\r"` when the line came from a CRLF file split on `"\n"`, so
   * a rewrite keeps the original line ending.
   */
  eol?: "\r";
};

const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[(.)\](?:\s+(.*))?$/;

export function parseTaskLine(line: string): TaskLine | null {
  const cr = line.endsWith("\r");
  const m = TASK_LINE.exec(cr ? line.slice(0, -1) : line);
  if (!m) return null;
  return {
    prefix: m[1],
    marker: m[2],
    text: m[3] ?? "",
    ...(cr ? { eol: "\r" as const } : {}),
  };
}

export function taskStatus(marker: string): "open" | "done" {
  return marker === " " ? "open" : "done";
}

export function renderTaskLine(task: TaskLine, marker: string): string {
  return `${task.prefix}[${marker}]${task.text ? ` ${task.text}` : ""}${task.eol ?? ""}`;
}
