import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAppLanguage } from "../src/i18n";
import {
  formatDate,
  formatDateTime,
  formatNumber,
  formatRegion,
  formatRelativeDays,
  formatTime,
  type DateShape
} from "../src/shared/dates";
import { formatPartialDate, formatPartialDateLong, formatPartialDateRange } from "../src/shared/utils";

// Every date in the app goes through shared/dates.ts so it follows the INTERFACE
// language, not the browser's. These pin each shape in both languages — Russian
// is the reason the module exists: it puts the day before the month, declines the
// month name, and ends a full date with "г.", none of which a hand-assembled
// `${month} ${day}, ${year}` can produce.

// A Monday, so the weekday shapes have something to name. Formatted with
// `utc: true` so the assertions don't move with the machine's time zone.
const INSTANT = Date.UTC(2026, 8, 7, 15, 4, 5);
// Local wall-clock 15:04:05 — the time shapes read local time, and this reads
// the same in every zone.
const LOCAL = new Date(2026, 8, 7, 15, 4, 5);
// Russian groups thousands with a NO-BREAK SPACE, not the plain one.
const NBSP = String.fromCharCode(160);

const SHAPES: DateShape[] = [
  "numeric", "medium", "long", "dayMonth", "dayMonthLong",
  "monthYear", "monthShortYear", "monthName", "weekday", "weekdayMedium"
];

const shapes = () => SHAPES.map((shape) => formatDate(INSTANT, shape, { utc: true }));

describe("formatDate", () => {
  it("spells out each shape in English", () => {
    expect(shapes()).toEqual([
      "9/7/2026",
      "Sep 7, 2026",
      "September 7, 2026",
      "Sep 7",
      "September 7",
      "September 2026",
      "Sep 2026",
      "September",
      "Monday",
      "Monday, Sep 7, 2026"
    ]);
  });

  it("defaults to the all-numeric shape", () => {
    expect(formatDate(INSTANT, undefined, { utc: true })).toBe("9/7/2026");
  });

  it("says nothing rather than something untrue", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate(undefined)).toBe("");
    expect(formatDate("")).toBe("");
    expect(formatDate("not a date")).toBe("");
  });

  it("reads a SQLite timestamp as UTC, like the rest of the app", () => {
    // "2026-09-07 15:04:05" carries no zone; treating it as local would shift it.
    expect(formatDate("2026-09-07 15:04:05", "medium", { utc: true })).toBe("Sep 7, 2026");
  });
});

describe("formatTime and formatDateTime", () => {
  it("writes the clock three ways in English", () => {
    expect(formatTime(LOCAL)).toBe("3:04 PM");
    expect(formatTime(LOCAL, "padded")).toBe("03:04 PM");
    expect(formatTime(LOCAL, "seconds")).toBe("3:04:05 PM");
    expect(formatTime(null)).toBe("");
  });

  it("joins a date and a time the way the language does", () => {
    expect(formatDateTime(INSTANT, "medium", "time", { utc: true })).toBe("Sep 7, 2026, 3:04 PM");
    expect(formatDateTime(INSTANT, "numeric", "seconds", { utc: true })).toBe("9/7/2026, 3:04:05 PM");
  });
});

describe("numbers, spans and regions in English", () => {
  it("groups a number and names a country", () => {
    expect(formatNumber(12_345)).toBe("12,345");
    expect(formatNumber(12_345.67, { maximumFractionDigits: 1 })).toBe("12,345.7");
    expect(formatNumber(Number.NaN)).toBe("NaN");
    expect(formatRelativeDays(-3)).toBe("3 days ago");
    expect(formatRegion("NL")).toBe("Netherlands");
    expect(formatRegion("ZZZ")).toBe("ZZZ");
  });
});

describe("in Russian", () => {
  beforeEach(async () => { await setAppLanguage("ru"); });
  afterEach(async () => { await setAppLanguage("en"); });

  it("spells out each shape the Russian way", () => {
    expect(shapes()).toEqual([
      "07.09.2026",
      "7 сент. 2026 г.",
      "7 сентября 2026 г.",
      "7 сент.",
      "7 сентября",
      "сентябрь 2026 г.",
      "сент. 2026 г.",
      "сентябрь",
      "понедельник",
      "понедельник, 7 сент. 2026 г."
    ]);
  });

  it("puts the day BEFORE the month — the ordering a hand-built string gets wrong", () => {
    const medium = formatDate(INSTANT, "medium", { utc: true });
    expect(medium).toContain("сент");
    expect(medium.indexOf("7")).toBeLessThan(medium.indexOf("сент"));
    const long = formatDate(INSTANT, "long", { utc: true });
    expect(long.indexOf("7")).toBeLessThan(long.indexOf("сентября"));
  });

  it("writes the clock on a 24-hour dial", () => {
    expect(formatTime(LOCAL)).toBe("15:04");
    expect(formatTime(LOCAL, "padded")).toBe("15:04");
    expect(formatTime(LOCAL, "seconds")).toBe("15:04:05");
    expect(formatDateTime(INSTANT, "medium", "time", { utc: true })).toBe("7 сент. 2026 г., 15:04");
  });

  it("groups numbers, spans and regions its own way", () => {
    expect(formatNumber(12_345)).toBe(`12${NBSP}345`);
    expect(formatNumber(12_345.67, { maximumFractionDigits: 1 })).toBe(`12${NBSP}345,7`);
    expect(formatRelativeDays(-3)).toBe("3 дня назад");
    expect(formatRegion("NL")).toBe("Нидерланды");
  });
});

describe("a language switch", () => {
  afterEach(async () => { await setAppLanguage("en"); });

  it("changes what the next call returns — the formatter cache is keyed on it", async () => {
    // The same shape, formatted three times across two switches: a cache that
    // forgot the language would keep handing back the first answer.
    expect(formatDate(INSTANT, "long", { utc: true })).toBe("September 7, 2026");
    await setAppLanguage("ru");
    expect(formatDate(INSTANT, "long", { utc: true })).toBe("7 сентября 2026 г.");
    expect(formatNumber(12_345)).toBe(`12${NBSP}345`);
    await setAppLanguage("en");
    expect(formatDate(INSTANT, "long", { utc: true })).toBe("September 7, 2026");
    expect(formatNumber(12_345)).toBe("12,345");
  });
});

// Partial dates are the one place a date used to be assembled by hand
// ("Sep 1, 1971" spelled out with a template), which is why they get their own
// assertions: the year-only and year-month cases still have to work.
describe("partial dates", () => {
  it("keeps every precision in English", () => {
    expect(formatPartialDate("1971")).toBe("1971");
    expect(formatPartialDate("1971-09")).toBe("Sep 1971");
    expect(formatPartialDate("1971-09-01")).toBe("Sep 1, 1971");
    expect(formatPartialDate(null)).toBe("");
    expect(formatPartialDateLong("1971-09-01")).toBe("Wednesday, Sep 1, 1971");
    expect(formatPartialDateLong("1971-09")).toBe("Sep 1971");
    expect(formatPartialDateRange("1971-09", "1972-03")).toBe("Sep 1971–Mar 1972");
    expect(formatPartialDateRange("1971", null)).toBe("1971");
  });

  it("orders and declines them in Russian", async () => {
    await setAppLanguage("ru");
    try {
      expect(formatPartialDate("1971")).toBe("1971");
      expect(formatPartialDate("1971-09")).toBe("сент. 1971 г.");
      expect(formatPartialDate("1971-09-01")).toBe("1 сент. 1971 г.");
      expect(formatPartialDateLong("1971-09-01")).toBe("среда, 1 сент. 1971 г.");
      expect(formatPartialDateRange("1971-09", "1972-03")).toBe("сент. 1971 г.–март 1972 г.");
    } finally {
      await setAppLanguage("en");
    }
  });
});
