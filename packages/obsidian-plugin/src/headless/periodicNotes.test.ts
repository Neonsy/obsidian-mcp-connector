import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import moment from "moment";
import type { App } from "obsidian";
import * as mocked from "obsidian";
import { createGuardedApp } from "$/shared/guardedApp";
import { compilePolicy } from "$/shared/pathPolicy";
import { createHeadlessApp } from "./headlessApp";
import * as shim from "./obsidianShim";
import {
  createPeriodicNotesBackend,
  loadPeriodicNotesConfig,
  renderTemplate,
  type PeriodicNotesConfig,
} from "./periodicNotes";

type Tools = {
  daily: typeof import("$/features/mcp-tools/tools/getOrCreateDailyNote");
  periodic: typeof import("$/features/mcp-tools/tools/getOrCreatePeriodicNote");
  append: typeof import("$/features/mcp-tools/tools/appendToPeriodicNote");
};

const original = { ...mocked };
let tools: Tools;

beforeAll(async () => {
  // The tools test `instanceof TFile`, so they need the headless classes.
  void mock.module("obsidian", () => ({
    ...original,
    TFile: shim.TFile,
    TFolder: shim.TFolder,
  }));
  tools = {
    daily: await import("$/features/mcp-tools/tools/getOrCreateDailyNote"),
    periodic:
      await import("$/features/mcp-tools/tools/getOrCreatePeriodicNote"),
    append: await import("$/features/mcp-tools/tools/appendToPeriodicNote"),
  };
});
afterAll(() => {
  void mock.module("obsidian", () => original);
});

let dir: string;
let root: string;
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(root, rel));
const config = (rel: string, value: unknown) =>
  write(`.obsidian/${rel}`, JSON.stringify(value));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-periodic-"));
  root = path.join(dir, "vault");
  fs.mkdirSync(root);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Result = { content: Array<{ text: string }>; isError?: boolean };
const json = (r: Result) => JSON.parse(r.content[0].text);

async function withApp<T>(fn: (app: App) => Promise<T>): Promise<T> {
  const { app, close } = await createHeadlessApp(root);
  try {
    return await fn(app);
  } finally {
    close();
  }
}

describe("loadPeriodicNotesConfig", () => {
  const load = async () => {
    const warnings: string[] = [];
    const loaded = await loadPeriodicNotesConfig(root, (m) => warnings.push(m));
    return { loaded, warnings };
  };

  test("a vault with no settings has every plugin off", async () => {
    expect(await load()).toEqual({ loaded: {}, warnings: [] });
  });

  test("the core Daily notes plugin, listed as enabled ids", async () => {
    config("core-plugins.json", ["file-explorer", "daily-notes"]);
    config("daily-notes.json", { folder: "Journal", format: "DD-MM-YYYY" });
    expect((await load()).loaded).toEqual({
      dailyNotes: { folder: "Journal", format: "DD-MM-YYYY" },
    });
  });

  test("the core Daily notes plugin, as a map of flags", async () => {
    config("core-plugins.json", { "daily-notes": true, templates: false });
    expect((await load()).loaded).toEqual({ dailyNotes: {} });
  });

  test("a disabled core plugin ignores its settings file", async () => {
    config("core-plugins.json", ["file-explorer"]);
    config("daily-notes.json", { folder: "Journal" });
    expect((await load()).loaded).toEqual({});
    config("core-plugins.json", { "daily-notes": false });
    expect((await load()).loaded).toEqual({});
  });

  test("the Periodic Notes plugin, with its enabled flags", async () => {
    config("community-plugins.json", ["periodic-notes"]);
    config("plugins/periodic-notes/data.json", {
      daily: { enabled: true, folder: "D", format: "YYYYMMDD" },
      weekly: { enabled: false, folder: "W" },
      monthly: "not an object",
      showGettingStartedBanner: false,
    });
    expect((await load()).loaded).toEqual({
      periodicNotes: {
        daily: { enabled: true, folder: "D", format: "YYYYMMDD" },
        weekly: { enabled: false, folder: "W" },
      },
    });
  });

  test("settings of a plugin that is not enabled are not read", async () => {
    config("community-plugins.json", ["calendar"]);
    config("plugins/periodic-notes/data.json", { daily: { enabled: true } });
    expect((await load()).loaded).toEqual({ calendar: {} });
  });

  test("an enabled Periodic Notes plugin without data has every period off", async () => {
    config("community-plugins.json", ["periodic-notes"]);
    expect((await load()).loaded).toEqual({ periodicNotes: {} });
  });

  test("the Calendar plugin's weekly options", async () => {
    config("community-plugins.json", ["calendar"]);
    config("plugins/calendar/data.json", { weeklyNoteFolder: "Wk" });
    expect((await load()).loaded).toEqual({
      calendar: { weeklyNoteFolder: "Wk" },
    });
  });

  test("an invalid file counts as missing and warns once", async () => {
    write(".obsidian/core-plugins.json", "[oops");
    config("community-plugins.json", ["periodic-notes"]);
    write(".obsidian/plugins/periodic-notes/data.json", "{");
    const { loaded, warnings } = await load();
    expect(loaded).toEqual({ periodicNotes: {} });
    expect(warnings).toEqual([
      "Ignoring .obsidian/core-plugins.json: invalid JSON",
      "Ignoring .obsidian/plugins/periodic-notes/data.json: invalid JSON",
    ]);
  });
});

describe("the settings seam", () => {
  const backend = (c: PeriodicNotesConfig) =>
    createPeriodicNotesBackend(c)({} as App);

  test("loaded flags follow the plugin that serves each period", () => {
    const none = backend({});
    expect(none.appHasDailyNotesPluginLoaded()).toBe(false);
    expect(none.appHasWeeklyNotesPluginLoaded()).toBe(false);

    const core = backend({ dailyNotes: {} });
    expect(core.appHasDailyNotesPluginLoaded()).toBe(true);
    expect(core.appHasMonthlyNotesPluginLoaded()).toBe(false);

    const periodic = backend({
      periodicNotes: {
        weekly: { enabled: true },
        monthly: { enabled: false },
        yearly: { enabled: true },
      },
    });
    expect(periodic.appHasDailyNotesPluginLoaded()).toBe(false);
    expect(periodic.appHasWeeklyNotesPluginLoaded()).toBe(true);
    expect(periodic.appHasMonthlyNotesPluginLoaded()).toBe(false);
    expect(periodic.appHasQuarterlyNotesPluginLoaded()).toBe(false);
    expect(periodic.appHasYearlyNotesPluginLoaded()).toBe(true);

    expect(backend({ calendar: {} }).appHasWeeklyNotesPluginLoaded()).toBe(
      true,
    );
  });

  test("settings take the library's defaults and trim the folder and template", () => {
    const b = backend({
      dailyNotes: { folder: "  Journal ", template: " T ", format: "" },
      periodicNotes: { yearly: { enabled: true, format: 5 } },
    });
    expect(b.getDailyNoteSettings()).toEqual({
      folder: "Journal",
      format: "YYYY-MM-DD",
      template: "T",
    });
    expect(b.getWeeklyNoteSettings().format).toBe("gggg-[W]ww");
    expect(b.getMonthlyNoteSettings().format).toBe("YYYY-MM");
    expect(b.getQuarterlyNoteSettings().format).toBe("YYYY-[Q]Q");
    expect(b.getYearlyNoteSettings().format).toBe("YYYY");
  });

  test("an enabled Periodic Notes section wins over the core plugin and Calendar", () => {
    const b = backend({
      dailyNotes: { folder: "Core" },
      calendar: { weeklyNoteFolder: "Cal" },
      periodicNotes: {
        daily: { enabled: true, folder: "Periodic" },
        weekly: { enabled: true, folder: "PeriodicWeekly" },
      },
    });
    expect(b.getDailyNoteSettings().folder).toBe("Periodic");
    expect(b.getWeeklyNoteSettings().folder).toBe("PeriodicWeekly");
    const disabled = backend({
      dailyNotes: { folder: "Core" },
      calendar: { weeklyNoteFolder: "Cal" },
      periodicNotes: {
        daily: { enabled: false, folder: "Periodic" },
        weekly: { enabled: false },
      },
    });
    expect(disabled.getDailyNoteSettings().folder).toBe("Core");
    expect(disabled.getWeeklyNoteSettings().folder).toBe("Cal");
  });
});

describe("renderTemplate", () => {
  const now = moment("2030-01-01T09:41:07");
  const date = moment("2026-03-15", "YYYY-MM-DD");
  const render = (
    period: Parameters<typeof renderTemplate>[0],
    template: string,
    d = date,
    format = "YYYY-MM-DD",
  ) => renderTemplate(period, template, d, d.format(format), format, now);

  test("daily: title, date, time, yesterday, tomorrow", () => {
    expect(
      render(
        "daily",
        "{{title}}|{{ date }}|{{TIME}}|{{yesterday}}|{{tomorrow}}",
      ),
    ).toBe("2026-03-15|2026-03-15|09:41|2026-03-14|2026-03-16");
  });

  test("date and time take an offset and a format", () => {
    expect(
      render(
        "daily",
        "{{date:dddd}}|{{date+1d:YYYY/MM/DD}}|{{date-1w}}|{{time:HH:mm:ss}}|{{date+2M:MMM}}",
      ),
    ).toBe("Sunday|2026/03/16|2026-03-08|09:41:07|May");
  });

  test("a time placeholder keeps the real clock time on the note's date", () => {
    expect(render("daily", "{{date:YYYY-MM-DD HH:mm}}")).toBe(
      "2026-03-15 09:41",
    );
  });

  test("weekly: weekday placeholders", () => {
    const monday = moment("2026-W11", "GGGG-[W]WW");
    expect(
      render(
        "weekly",
        "{{title}}|{{monday:YYYY-MM-DD}}|{{ Sunday : DD }}|{{saturday:MMM D}}",
        monday,
        "gggg-[W]ww",
      ),
    ).toBe("2026-W11|2026-03-09|08|Mar 14");
  });

  test("monthly, quarterly and yearly: title and date, and a bare time as the library does", () => {
    for (const period of ["monthly", "quarterly", "yearly"] as const) {
      // The library's first pass for these periods also takes a bare
      // `{{time}}`, so it renders the note's date format, not the clock.
      expect(
        render(period, "{{title}}|{{date}}|{{time}}", date, "YYYY-MM"),
      ).toBe("2026-03|2026-03|2026-03");
      expect(render(period, "{{time:HH:mm}}", date, "YYYY-MM")).toBe("09:41");
    }
  });

  test("daily-only placeholders stay in other periods, and Templater syntax stays everywhere", () => {
    expect(render("monthly", "{{yesterday}}")).toBe("{{yesterday}}");
    expect(render("daily", "<% tp.date.now() %> {{unknown}}")).toBe(
      "<% tp.date.now() %> {{unknown}}",
    );
  });
});

describe("get_or_create_daily_note", () => {
  test("without any plugin: an empty note at the ISO path, then read back", async () => {
    await withApp(async (app) => {
      const first = json(
        await tools.daily.getOrCreateDailyNoteHandler({
          arguments: { date: "2026-03-15" },
          app,
        }),
      );
      expect(first).toMatchObject({
        path: "2026-03-15.md",
        content: "",
        created: true,
      });
      expect(read("2026-03-15.md")).toBe("");
      write("2026-03-15.md", "later");
      const second = json(
        await tools.daily.getOrCreateDailyNoteHandler({
          arguments: { date: "2026-03-15" },
          app,
        }),
      );
      expect(second.created).toBe(false);
    });
  });

  test("with the core plugin: folder, nested format and template substitution", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", {
      folder: "/Journal/",
      format: "YYYY/MM/DD",
      template: "Templates/Daily",
    });
    write(
      "Templates/Daily.md",
      "# {{title}}\n{{date:dddd}} {{tomorrow}}\n{{time}}\n<% tp.date.now() %>\n",
    );
    await withApp(async (app) => {
      const out = json(
        await tools.daily.getOrCreateDailyNoteHandler({
          arguments: { date: "2026-03-15" },
          app,
        }),
      );
      expect(out.path).toBe("Journal/2026/03/15.md");
      expect(out.created).toBe(true);
      expect(read("Journal/2026/03/15.md")).toMatch(
        /^# 2026\/03\/15\nSunday 2026\/03\/16\n\d\d:\d\d\n<% tp\.date\.now\(\) %>\n$/,
      );
      expect(out.content).toBe(read("Journal/2026/03/15.md"));
    });
  });

  test("a template that cannot be read gives an empty note", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { template: "Templates/Missing" });
    await withApp(async (app) => {
      const out = json(
        await tools.daily.getOrCreateDailyNoteHandler({
          arguments: { date: "2026-03-15" },
          app,
        }),
      );
      expect(out).toMatchObject({ path: "2026-03-15.md", content: "" });
    });
  });

  test("with the Periodic Notes plugin on daily, its settings replace the core plugin's", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { folder: "Core" });
    config("community-plugins.json", ["periodic-notes"]);
    config("plugins/periodic-notes/data.json", {
      daily: { enabled: true, folder: "PN", format: "YYYYMMDD" },
    });
    await withApp(async (app) => {
      const out = json(
        await tools.daily.getOrCreateDailyNoteHandler({
          arguments: { date: "2026-03-15" },
          app,
        }),
      );
      expect(out.path).toBe("PN/20260315.md");
    });
  });

  test("a plugin that is installed but off changes nothing", async () => {
    config("community-plugins.json", ["periodic-notes"]);
    config("plugins/periodic-notes/data.json", {
      daily: { enabled: false, folder: "PN" },
    });
    await withApp(async (app) => {
      const out = json(
        await tools.daily.getOrCreateDailyNoteHandler({
          arguments: { date: "2026-03-15" },
          app,
        }),
      );
      expect(out.path).toBe("2026-03-15.md");
    });
  });

  test("without a date it uses today on the host clock", async () => {
    await withApp(async (app) => {
      const before = moment().format("YYYY-MM-DD");
      const out = json(
        await tools.daily.getOrCreateDailyNoteHandler({ arguments: {}, app }),
      );
      const after = moment().format("YYYY-MM-DD");
      // A run that crosses midnight may land on either day.
      expect([`${before}.md`, `${after}.md`]).toContain(out.path);
    });
  });
});

describe("the guarded app", () => {
  /** The `App` the tools receive in production: the raw one behind a policy. */
  const guarded = (app: App, folders: string[]) =>
    createGuardedApp(app, () => compilePolicy(folders));

  test("a template in an excluded folder reads as missing: nothing of it is copied", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { template: "Secret/Template" });
    write("Secret/Template.md", "TOP SECRET {{title}}");
    await withApp(async (app) => {
      const out = json(
        await tools.daily.getOrCreateDailyNoteHandler({
          arguments: { date: "2026-03-15" },
          app: guarded(app, ["Secret"]),
        }),
      );
      expect(out).toMatchObject({ path: "2026-03-15.md", content: "" });
      expect(read("2026-03-15.md")).toBe("");
      expect(read("Secret/Template.md")).toBe("TOP SECRET {{title}}");
    });
  });

  test("the same template is used when its folder is not excluded", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { template: "Secret/Template" });
    write("Secret/Template.md", "TOP SECRET {{title}}");
    await withApp(async (app) => {
      const out = json(
        await tools.daily.getOrCreateDailyNoteHandler({
          arguments: { date: "2026-03-15" },
          app: guarded(app, ["Other"]),
        }),
      );
      expect(out.content).toBe("TOP SECRET 2026-03-15");
    });
  });

  test("a destination in an excluded folder is refused before anything is written", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { folder: "Secret/Journal" });
    config("community-plugins.json", ["periodic-notes"]);
    config("plugins/periodic-notes/data.json", {
      weekly: { enabled: true, folder: "Secret/Weeks" },
    });
    await withApp(async (app) => {
      const guard = guarded(app, ["Secret"]);
      await expect(
        tools.daily.getOrCreateDailyNoteHandler({
          arguments: { date: "2026-03-15" },
          app: guard,
        }),
      ).rejects.toThrow();
      await expect(
        tools.periodic.getOrCreatePeriodicNoteHandler({
          arguments: { period: "weekly", date: "2026-W11" },
          app: guard,
        }),
      ).rejects.toThrow();
      await expect(
        tools.append.appendToPeriodicNoteHandler({
          arguments: { content: "x", date: "2026-03-15" },
          app: guard,
        }),
      ).rejects.toThrow();
      expect(exists("Secret")).toBe(false);
    });
  });
});

describe("get_or_create_periodic_note", () => {
  test("weekly through the Periodic Notes plugin, with weekday placeholders", async () => {
    config("community-plugins.json", ["periodic-notes"]);
    config("plugins/periodic-notes/data.json", {
      weekly: {
        enabled: true,
        folder: "Weekly",
        template: "Templates/Week.md",
      },
    });
    write("Templates/Week.md", "Week of {{monday:YYYY-MM-DD}} ({{title}})");
    await withApp(async (app) => {
      const out = json(
        await tools.periodic.getOrCreatePeriodicNoteHandler({
          arguments: { period: "weekly", date: "2026-W11" },
          app,
        }),
      );
      expect(out).toMatchObject({
        period: "weekly",
        path: "Weekly/2026-W11.md",
        content: "Week of 2026-03-09 (2026-W11)",
        created: true,
      });
    });
  });

  test("monthly, quarterly and yearly use their own sections", async () => {
    config("community-plugins.json", ["periodic-notes"]);
    config("plugins/periodic-notes/data.json", {
      monthly: { enabled: true, folder: "M", format: "YYYY-MM" },
      quarterly: { enabled: true, folder: "Q" },
      yearly: { enabled: true, folder: "Y", template: "Templates/Year" },
    });
    write("Templates/Year.md", "Y {{title}}");
    await withApp(async (app) => {
      const paths = [];
      for (const [period, date] of [
        ["monthly", "2026-03"],
        ["quarterly", "2026-Q1"],
        ["yearly", "2026"],
        ["daily", "2026-03-15"],
      ] as const) {
        const out = json(
          await tools.periodic.getOrCreatePeriodicNoteHandler({
            arguments: { period, date },
            app,
          }),
        );
        paths.push(out.path);
      }
      expect(paths).toEqual([
        "M/2026-03.md",
        "Q/2026-Q1.md",
        "Y/2026.md",
        "2026-03-15.md",
      ]);
      expect(read("Y/2026.md")).toBe("Y 2026");
    });
  });

  test("the Calendar plugin serves weekly notes when Periodic Notes does not", async () => {
    config("community-plugins.json", ["calendar"]);
    config("plugins/calendar/data.json", {
      weeklyNoteFolder: "Cal",
      weeklyNoteFormat: "[W]WW-GGGG",
    });
    await withApp(async (app) => {
      const out = json(
        await tools.periodic.getOrCreatePeriodicNoteHandler({
          arguments: { period: "weekly", date: "2026-W11" },
          app,
        }),
      );
      expect(out.path).toBe("Cal/W11-2026.md");
    });
  });

  test("an invalid date is refused before anything is written", async () => {
    await withApp(async (app) => {
      const out = await tools.periodic.getOrCreatePeriodicNoteHandler({
        arguments: { period: "monthly", date: "2026-13" },
        app,
      });
      expect(out.isError).toBe(true);
      expect(json(out).errorCode).toBe("invalid_date_for_period");
      expect(exists("2026-13.md")).toBe(false);
    });
  });
});

describe("append_to_periodic_note", () => {
  test("creates the note from its template, then appends under a heading", async () => {
    config("core-plugins.json", ["daily-notes"]);
    config("daily-notes.json", { folder: "Journal", template: "Daily" });
    write("Daily.md", "# {{title}}\n## Log\n## Notes\nend\n");
    await withApp(async (app) => {
      const out = json(
        await tools.append.appendToPeriodicNoteHandler({
          arguments: {
            period: "daily",
            date: "2026-03-15",
            content: "- did a thing",
            underHeading: "Log",
          },
          app,
        }),
      );
      expect(out).toMatchObject({
        period: "daily",
        path: "Journal/2026-03-15.md",
        appended: true,
        created: true,
      });
      expect(read("Journal/2026-03-15.md")).toBe(
        "# 2026-03-15\n## Log\n- did a thing\n\n\n## Notes\nend\n",
      );
      const again = json(
        await tools.append.appendToPeriodicNoteHandler({
          arguments: { date: "2026-03-15", content: "tail" },
          app,
        }),
      );
      expect(again.created).toBe(false);
      expect(read("Journal/2026-03-15.md")).toMatch(/end\ntail\n\n$/);
    });
  });

  test("a missing heading keeps the created note and reports it", async () => {
    await withApp(async (app) => {
      const out = await tools.append.appendToPeriodicNoteHandler({
        arguments: { content: "x", date: "2026-03-15", underHeading: "Nope" },
        app,
      });
      expect(out.isError).toBe(true);
      expect(json(out)).toMatchObject({
        errorCode: "heading_not_found",
        created: true,
      });
      expect(exists("2026-03-15.md")).toBe(true);
    });
  });
});
