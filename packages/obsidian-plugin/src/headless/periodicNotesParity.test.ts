/**
 * Drift guard for `periodicNotes.ts`, which reimplements the rules of
 * `obsidian-daily-notes-interface` for a host with no Obsidian. The real
 * library (frozen at 0.9.4) runs here against a minimal fake host, and the
 * path, the template output, the settings and the loaded flags it produces
 * are compared with the reimplementation's for all five periods. A change
 * to either side that makes them differ fails this file.
 *
 * The test preload replaces the library with a stub, so the real file is
 * evaluated directly with a stand-in `obsidian` module. The fake host sits
 * on `globalThis.window` only while one case runs.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import moment from "moment";
import type { App } from "obsidian";
import {
  createPeriodicNotesBackend,
  type PeriodicNotesConfig,
} from "./periodicNotes";

type Period = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
const PERIODS: readonly Period[] = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
];

type Moment = moment.Moment;
type Settings = { format: string; folder: string; template: string };
type Lib = {
  [K in `appHas${Capitalize<Period>}NotesPluginLoaded`]: () => unknown;
} & {
  [K in `get${Capitalize<Period>}NoteSettings`]: () => Settings;
} & {
  [K in `create${Capitalize<Period>}Note`]: (date: Moment) => Promise<unknown>;
};

/** Obsidian's `normalizePath`, as the library's `obsidian` import sees it. */
function normalizePath(p: string): string {
  const clean = p
    .replace(/[\\/]+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/ /g, " ")
    .normalize("NFC");
  return clean === "" ? "/" : clean;
}

/** The unmodified library file, run against a stand-in `obsidian`. */
function loadRealLibrary(): Lib {
  const file = createRequire(import.meta.url).resolve(
    "obsidian-daily-notes-interface",
  );
  const source = fs.readFileSync(file, "utf8");
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module) {${source}\n})`,
    { filename: file },
  ) as (exports: object, require: (id: string) => unknown, m: object) => void;
  const exports: Record<string, unknown> = {};
  wrapper(
    exports,
    (id) => {
      if (id !== "obsidian") throw new Error(`unexpected require: ${id}`);
      return { normalizePath, Notice: class {} };
    },
    { exports },
  );
  return exports as unknown as Lib;
}

/** A vault that, like Obsidian's, refuses a file whose folder is missing. */
function fakeVault(template: string | undefined) {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  if (template !== undefined) {
    files.set("Templates/Note.md", template);
    folders.add("Templates");
  }
  const entry = (path: string) =>
    files.has(path) || folders.has(path) ? { path } : null;
  const vault = {
    getAbstractFileByPath: entry,
    async createFolder(path: string) {
      if (folders.has(path)) throw new Error("Folder already exists.");
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        folders.add(parts.slice(0, i).join("/"));
      }
    },
    async create(path: string, content: string) {
      const slash = path.lastIndexOf("/");
      if (slash > 0 && !folders.has(path.slice(0, slash))) {
        throw new Error("ENOENT: parent folder is missing");
      }
      if (files.has(path)) throw new Error("File already exists.");
      files.set(path, content);
      return { path };
    },
    async cachedRead(file: { path: string }) {
      return files.get(file.path) ?? "";
    },
  };
  const metadataCache = {
    getFirstLinkpathDest(linkpath: string) {
      for (const candidate of [linkpath, `${linkpath}.md`]) {
        if (files.has(candidate)) return { path: candidate };
      }
      return null;
    },
  };
  const created = () => ({
    files: [...files].filter(([p]) => p !== "Templates/Note.md"),
    folders: [...folders].filter((p) => p !== "Templates").sort(),
  });
  return { vault, metadataCache, created };
}

/** The host state the library reads, derived from the same plugin config. */
function fakeApp(
  config: PeriodicNotesConfig,
  host: ReturnType<typeof fakeVault>,
) {
  const plugins: Record<string, object> = {};
  if (config.periodicNotes) {
    plugins["periodic-notes"] = { settings: config.periodicNotes };
  }
  if (config.calendar) plugins["calendar"] = { options: config.calendar };
  return {
    vault: host.vault,
    metadataCache: host.metadataCache,
    plugins: { getPlugin: (id: string) => plugins[id] },
    internalPlugins: {
      plugins: {
        "daily-notes": config.dailyNotes ? { enabled: true } : undefined,
      },
      getPluginById: (id: string) =>
        id === "daily-notes" && config.dailyNotes
          ? { instance: { options: config.dailyNotes } }
          : undefined,
    },
    foldManager: { load: () => null, save: () => {} },
  };
}

/** Run `fn` with the fake host as `window.app`, restoring `window` after. */
async function withHost<T>(
  app: object,
  now: Moment,
  fn: () => Promise<T>,
): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const saved = { app: g.app, moment: g.moment };
  const hadApp = "app" in g;
  const hadMoment = "moment" in g;
  // The library reports an unreadable template with `console.error`.
  const consoleError = console.error;
  console.error = () => {};
  // `moment()` with no argument is the clock; a fixed one keeps `{{time}}`
  // from depending on when each side happens to run.
  g.moment = Object.assign(
    (...args: unknown[]) =>
      args.length === 0
        ? now.clone()
        : (moment as unknown as (...a: unknown[]) => Moment)(...args),
    moment,
  );
  g.app = app;
  try {
    return await fn();
  } finally {
    console.error = consoleError;
    if (hadApp) g.app = saved.app;
    else delete g.app;
    if (hadMoment) g.moment = saved.moment;
    else delete g.moment;
  }
}

const NOW = moment("2030-01-01T09:41:07");
const DATES = ["2026-03-15", "2024-02-29", "2026-12-31", "2027-01-03"];

const DAILY_TEMPLATE = [
  "# {{title}} | {{ date }} | {{TIME}} | {{time:HH:mm:ss}}",
  "{{date+1d:dddd, MMM D}} | {{date-1w}} | {{date+2M:MMM}} | {{date:YYYY}}",
  "{{yesterday}} | {{tomorrow}} | {{ Yesterday }}",
  "{{monday:YYYY-MM-DD}} <% tp.date.now() %> {{unknown}}",
].join("\n");
const WEEKLY_TEMPLATE = [
  "{{title}} | {{date}} | {{time}} | {{date+1w:gggg-[W]ww}}",
  "{{monday:YYYY-MM-DD}} | {{ Sunday : DD }} | {{saturday:MMM D}}",
  "{{yesterday}} {{tomorrow}}",
].join("\n");
const OTHER_TEMPLATE = [
  "{{title}} | {{date}} | {{time}} | {{time:HH:mm}}",
  "{{date+1M:YYYY-MM}} | {{date-1y:YYYY}} | {{yesterday}} | {{monday:DD}}",
].join("\n");

type Case = {
  name: string;
  config: PeriodicNotesConfig;
  template?: string;
};

const CASES: Case[] = [
  { name: "no plugin on", config: {} },
  {
    name: "core daily: nested folder and format, every placeholder",
    config: {
      dailyNotes: {
        folder: "/Journal/Daily/",
        format: "YYYY/MM/DD",
        template: "Templates/Note",
      },
    },
    template: DAILY_TEMPLATE,
  },
  {
    name: "core daily: defaults, template with an extension and spaces",
    config: {
      dailyNotes: { folder: "  Days ", template: " /Templates/Note.md " },
    },
    template: DAILY_TEMPLATE,
  },
  {
    name: "periodic notes daily wins over the core plugin",
    config: {
      dailyNotes: { folder: "Core", format: "DD-MM-YYYY" },
      periodicNotes: {
        daily: {
          enabled: true,
          folder: "PN/Sub",
          format: "YYYYMMDD",
          template: "Templates/Note",
        },
      },
    },
    template: DAILY_TEMPLATE,
  },
  {
    name: "periodic notes daily switched off falls back to the core plugin",
    config: {
      dailyNotes: { folder: "Core" },
      periodicNotes: { daily: { enabled: false, folder: "PN" } },
    },
  },
  {
    name: "calendar weekly: folder, format and template",
    config: {
      calendar: {
        weeklyNoteFolder: "Cal/Weeks",
        weeklyNoteFormat: "[W]WW-GGGG",
        weeklyNoteTemplate: "Templates/Note",
      },
    },
    template: WEEKLY_TEMPLATE,
  },
  {
    name: "periodic notes weekly: empty format takes the default",
    config: {
      calendar: { weeklyNoteFolder: "Cal" },
      periodicNotes: {
        weekly: {
          enabled: true,
          folder: "Weekly/",
          format: "",
          template: "Templates/Note",
        },
      },
    },
    template: WEEKLY_TEMPLATE,
  },
  {
    name: "periodic notes monthly, quarterly and yearly",
    config: {
      periodicNotes: {
        monthly: {
          enabled: true,
          folder: "M",
          format: "YYYY/MM",
          template: "Templates/Note",
        },
        quarterly: {
          enabled: true,
          folder: "Q/Quarters",
          format: "YYYY-[Q]Q",
          template: "Templates/Note",
        },
        yearly: { enabled: true, folder: "Y", template: "Templates/Note" },
      },
    },
    template: OTHER_TEMPLATE,
  },
  {
    name: "periodic notes with default formats and no folder",
    config: {
      periodicNotes: {
        monthly: { enabled: true },
        quarterly: { enabled: true },
        yearly: { enabled: true },
      },
    },
  },
  {
    name: "template that is not in the vault",
    config: { dailyNotes: { template: "Templates/Note" } },
  },
];

const cap = (p: Period) =>
  (p[0].toUpperCase() + p.slice(1)) as Capitalize<Period>;

describe("periodicNotes.ts against the real obsidian-daily-notes-interface", () => {
  const lib = loadRealLibrary();

  for (const testCase of CASES) {
    test(testCase.name, async () => {
      for (const period of PERIODS) {
        const key = cap(period);
        for (const day of DATES) {
          const date = moment(day, "YYYY-MM-DD");

          const realHost = fakeVault(testCase.template);
          const real = await withHost(
            fakeApp(testCase.config, realHost),
            NOW,
            async () => ({
              loaded: PERIODS.map((p) =>
                Boolean(lib[`appHas${cap(p)}NotesPluginLoaded`]()),
              ),
              settings: PERIODS.map((p) => lib[`get${cap(p)}NoteSettings`]()),
              file: await lib[`create${key}Note`](date.clone()),
            }),
          );

          const ownHost = fakeVault(testCase.template);
          const own = createPeriodicNotesBackend(testCase.config, () =>
            NOW.clone(),
          )({
            vault: ownHost.vault,
            metadataCache: ownHost.metadataCache,
          } as unknown as App);
          const mine = {
            loaded: PERIODS.map((p) =>
              own[`appHas${cap(p)}NotesPluginLoaded`](),
            ),
            settings: PERIODS.map((p) => own[`get${cap(p)}NoteSettings`]()),
            file: await own[`create${key}Note`](date.clone() as never),
          };

          const label = `${period} ${day}`;
          expect({ label, loaded: mine.loaded }).toEqual({
            label,
            loaded: real.loaded,
          });
          expect({ label, settings: mine.settings }).toEqual({
            label,
            settings: real.settings,
          });
          expect({ label, path: (mine.file as { path: string }).path }).toEqual(
            {
              label,
              path: (real.file as { path: string }).path,
            },
          );
          // Every created file with its text, and every folder made for it.
          expect({ label, ...ownHost.created() }).toEqual({
            label,
            ...realHost.created(),
          });
        }
      }
    });
  }

  test("the fake host is removed from window afterwards", async () => {
    const g = globalThis as Record<string, unknown>;
    const before = { app: g.app, moment: g.moment, error: console.error };
    const inside = await withHost({ marker: true }, NOW, async () => ({
      app: g.app,
      moment: g.moment,
    }));
    expect(inside.app).toEqual({ marker: true });
    expect(typeof inside.moment).toBe("function");
    expect({ app: g.app, moment: g.moment, error: console.error }).toEqual(
      before,
    );
  });
});
