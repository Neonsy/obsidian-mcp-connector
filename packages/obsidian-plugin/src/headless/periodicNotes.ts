/**
 * Daily and periodic notes without Obsidian.
 *
 * On desktop the three periodic-note tools reach `obsidian-daily-notes-
 * interface`, which reads the core Daily notes plugin, the Periodic Notes
 * plugin and the Calendar plugin through `window.app` and creates notes
 * with their template substitutions. Headless has no `window.app`, so this
 * module supplies the same seam (`PeriodicNotesLibLike`) from the vault's
 * own files, read once at startup: `core-plugins.json` and
 * `community-plugins.json` say which plugins are on, and
 * `daily-notes.json` and the plugins' `data.json` hold their settings.
 * The rules below follow that library's, setting by setting.
 *
 * A template is a note in the vault, read as text. Its `{{date}}`,
 * `{{time}}`, `{{title}}`, `{{yesterday}}`, `{{tomorrow}}` and weekday
 * placeholders are substituted. No template engine runs, so Templater
 * syntax stays as written.
 */

import type { App, TFile } from "obsidian";
import type { Moment } from "moment";
import { ensureParentFolderExists } from "$/features/mcp-tools/services/ensureFolderExists";
import type {
  PeriodicNotesLibLike,
  PeriodicNoteSettings,
  PeriodType,
} from "$/features/mcp-tools/services/periodicNotesDetector";
import { logger } from "$/shared/logger";
import { moment } from "./obsidianShim";
import { readConfigJson } from "./vaultSettings";

/** What one period's settings file or plugin section may hold. */
type RawSettings = { folder?: unknown; format?: unknown; template?: unknown };

type PeriodSection = RawSettings & { enabled: boolean };

/** The plugin state the vault's files describe. */
export type PeriodicNotesConfig = {
  /** Core Daily notes plugin: present when enabled, with its options. */
  dailyNotes?: RawSettings;
  /** Periodic Notes plugin: present when enabled, one section per period. */
  periodicNotes?: Partial<Record<PeriodType, PeriodSection>>;
  /** Calendar plugin: present when enabled, with its weekly-note options. */
  calendar?: {
    weeklyNoteFormat?: unknown;
    weeklyNoteFolder?: unknown;
    weeklyNoteTemplate?: unknown;
  };
};

const PERIODS: readonly PeriodType[] = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
];

const DEFAULT_FORMAT: Record<PeriodType, string> = {
  daily: "YYYY-MM-DD",
  weekly: "gggg-[W]ww",
  monthly: "YYYY-MM",
  quarterly: "YYYY-[Q]Q",
  yearly: "YYYY",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `core-plugins.json` is a list of enabled ids, or a map of id to flag. */
function coreEnabled(json: unknown, id: string): boolean {
  if (Array.isArray(json)) return json.includes(id);
  return isRecord(json) && json[id] === true;
}

function communityEnabled(json: unknown, id: string): boolean {
  return Array.isArray(json) && json.includes(id);
}

/** The Periodic Notes plugin's `data.json`, keeping only the period sections. */
function parsePeriodicNotesData(
  json: unknown,
): Partial<Record<PeriodType, PeriodSection>> {
  const sections: Partial<Record<PeriodType, PeriodSection>> = {};
  if (!isRecord(json)) return sections;
  for (const period of PERIODS) {
    const section = json[period];
    if (isRecord(section)) {
      sections[period] = { ...section, enabled: Boolean(section.enabled) };
    }
  }
  return sections;
}

/**
 * Read which periodic-note plugins are on and their settings. A missing
 * or invalid file means that plugin is off, which is what makes every tool
 * fall back to an empty note named by ISO date at the vault root.
 */
export async function loadPeriodicNotesConfig(
  root: string,
  warn: (message: string) => void,
): Promise<PeriodicNotesConfig> {
  const config: PeriodicNotesConfig = {};
  const core = await readConfigJson(root, "core-plugins.json", warn);
  if (coreEnabled(core, "daily-notes")) {
    const options = await readConfigJson(root, "daily-notes.json", warn);
    config.dailyNotes = isRecord(options) ? options : {};
  }
  const community = await readConfigJson(root, "community-plugins.json", warn);
  if (communityEnabled(community, "periodic-notes")) {
    config.periodicNotes = parsePeriodicNotesData(
      await readConfigJson(root, "plugins/periodic-notes/data.json", warn),
    );
  }
  if (communityEnabled(community, "calendar")) {
    const options = await readConfigJson(
      root,
      "plugins/calendar/data.json",
      warn,
    );
    config.calendar = isRecord(options) ? options : {};
  }
  return config;
}

/* -------------------------------------------------------------------- */
/* Settings                                                              */
/* -------------------------------------------------------------------- */

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function withDefaults(
  period: PeriodType,
  raw: RawSettings,
): Required<PeriodicNoteSettings> {
  return {
    format:
      typeof raw.format === "string" && raw.format
        ? raw.format
        : DEFAULT_FORMAT[period],
    folder: text(raw.folder),
    template: text(raw.template),
  };
}

function isLoaded(config: PeriodicNotesConfig, period: PeriodType): boolean {
  if (config.periodicNotes?.[period]?.enabled) return true;
  if (period === "daily") return config.dailyNotes !== undefined;
  if (period === "weekly") return config.calendar !== undefined;
  return false;
}

function settingsOf(
  config: PeriodicNotesConfig,
  period: PeriodType,
): Required<PeriodicNoteSettings> {
  const section = config.periodicNotes?.[period];
  if (section?.enabled) return withDefaults(period, section);
  if (period === "daily") return withDefaults(period, config.dailyNotes ?? {});
  if (period === "weekly") {
    const calendar = config.calendar ?? {};
    return withDefaults(period, {
      format: calendar.weeklyNoteFormat,
      folder: calendar.weeklyNoteFolder,
      template: calendar.weeklyNoteTemplate,
    });
  }
  return withDefaults(period, {});
}

/* -------------------------------------------------------------------- */
/* Creation                                                              */
/* -------------------------------------------------------------------- */

/** Obsidian's `normalizePath`: forward slashes, no leading or trailing slash. */
function normalizePath(p: string): string {
  const clean = p
    .replace(/ /g, " ")
    .normalize("NFC")
    .replace(/[\\/]+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return clean === "" ? "/" : clean;
}

function joinPath(...parts: string[]): string {
  return parts
    .flatMap((part) => part.split("/"))
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** The weekday names starting from the locale's first day of the week. */
function weekdayOrder(): string[] {
  const names = [...WEEKDAYS];
  for (let start = moment.localeData().firstDayOfWeek(); start > 0; start--) {
    names.push(names.shift()!);
  }
  return names;
}

/** `{{date}}` / `{{time}}` with an optional `+1d` offset and `:format`. */
const DATE_OR_TIME = /{{\s*(date|time)\s*(([+-]\d+)([yqmwdhs]))?\s*(:.+?)?}}/gi;

/**
 * Substitute the placeholders of `period`'s template. The order of the
 * passes is the library's, because an earlier pass changes what a later
 * one sees.
 */
export function renderTemplate(
  period: PeriodType,
  contents: string,
  date: Moment,
  filename: string,
  format: string,
  now: Moment,
): string {
  const dateOrTime = (
    _match: string,
    _kind: string,
    offset: string | undefined,
    amount: string,
    unit: string,
    momentFormat: string | undefined,
  ): string => {
    const shifted = date.clone().set({
      hour: now.get("hour"),
      minute: now.get("minute"),
      second: now.get("second"),
    });
    if (offset) {
      shifted.add(
        parseInt(amount, 10),
        unit as moment.unitOfTime.DurationConstructor,
      );
    }
    return momentFormat
      ? shifted.format(momentFormat.substring(1).trim())
      : shifted.format(format);
  };
  const bare = (name: string, value: string) =>
    [new RegExp(`{{\\s*${name}\\s*}}`, "gi"), value] as const;
  const time = bare("time", now.format("HH:mm"));
  const title = bare("title", filename);
  const dateName = bare("date", filename);

  const passes: Array<(s: string) => string> = [];
  const replace = (pattern: RegExp, value: string) => (s: string) =>
    s.replace(pattern, value);
  const generic = (s: string) => s.replace(DATE_OR_TIME, dateOrTime);

  switch (period) {
    case "daily":
      passes.push(
        replace(...dateName),
        replace(...time),
        replace(...title),
        generic,
        replace(
          ...bare("yesterday", date.clone().subtract(1, "day").format(format)),
        ),
        replace(...bare("tomorrow", date.clone().add(1, "d").format(format))),
      );
      break;
    case "weekly":
      passes.push(generic, replace(...title), replace(...time), (s) =>
        s.replace(
          /{{\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*:(.*?)}}/gi,
          (_m, dayName: string, momentFormat: string) =>
            date
              .clone()
              .weekday(weekdayOrder().indexOf(dayName.toLowerCase()))
              .format(momentFormat.trim()),
        ),
      );
      break;
    default:
      passes.push(
        generic,
        replace(...dateName),
        replace(...time),
        replace(...title),
      );
  }
  return passes.reduce((s, pass) => pass(s), contents);
}

type Backend = {
  app: App;
  config: PeriodicNotesConfig;
  now: () => Moment;
};

/** The template's text, or empty when none is set or it cannot be read. */
async function readTemplate(app: App, template: string): Promise<string> {
  const templatePath = normalizePath(template);
  if (templatePath === "/") return "";
  try {
    const file = app.metadataCache.getFirstLinkpathDest(templatePath, "");
    if (file === null) throw new Error("not found in the vault");
    return await app.vault.cachedRead(file);
  } catch (err) {
    logger.warn(
      `Failed to read the periodic note template '${templatePath}': ${err instanceof Error ? err.message : String(err)}`,
    );
    return "";
  }
}

async function createNote(
  { app, config, now }: Backend,
  period: PeriodType,
  date: Moment,
): Promise<TFile> {
  const { template, format, folder } = settingsOf(config, period);
  const contents = await readTemplate(app, template);
  const filename = date.format(format);
  const path = normalizePath(
    joinPath(folder, filename.endsWith(".md") ? filename : `${filename}.md`),
  );
  await ensureParentFolderExists(app, path);
  return app.vault.create(
    path,
    renderTemplate(period, contents, date, filename, format, now()),
  );
}

/**
 * The periodic-notes seam over `config`. It builds the backend for the
 * `App` a tool call received, so the template is read and the note is
 * created through that `App` (the guarded one) and never through a
 * captured raw one. `now` is the clock the `{{time}}` placeholder reads.
 */
export function createPeriodicNotesBackend(
  config: PeriodicNotesConfig,
  now: () => Moment = () => moment(),
): (app: App) => PeriodicNotesLibLike {
  return (app) => backendFor({ app, config, now });
}

function backendFor(backend: Backend): PeriodicNotesLibLike {
  const { config } = backend;
  const create = (period: PeriodType) => (m: unknown) =>
    createNote(backend, period, m as Moment);
  return {
    appHasDailyNotesPluginLoaded: () => isLoaded(config, "daily"),
    appHasWeeklyNotesPluginLoaded: () => isLoaded(config, "weekly"),
    appHasMonthlyNotesPluginLoaded: () => isLoaded(config, "monthly"),
    appHasQuarterlyNotesPluginLoaded: () => isLoaded(config, "quarterly"),
    appHasYearlyNotesPluginLoaded: () => isLoaded(config, "yearly"),
    getDailyNoteSettings: () => settingsOf(config, "daily"),
    getWeeklyNoteSettings: () => settingsOf(config, "weekly"),
    getMonthlyNoteSettings: () => settingsOf(config, "monthly"),
    getQuarterlyNoteSettings: () => settingsOf(config, "quarterly"),
    getYearlyNoteSettings: () => settingsOf(config, "yearly"),
    createDailyNote: create("daily"),
    createWeeklyNote: create("weekly"),
    createMonthlyNote: create("monthly"),
    createQuarterlyNote: create("quarterly"),
    createYearlyNote: create("yearly"),
  };
}
