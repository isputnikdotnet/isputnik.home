import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppLanguage } from "../src/i18n";
import { relativeTime } from "../src/shared/relativeTime";

// One helper, three amounts of room. Each style is the wording one surface
// already used before the three copies were merged, so these pin it word for
// word — and in Russian at 1, 2, 5 and 21, the counts that pick its three plural
// forms ("1 день", "2 дня", "5 дней", "21 день").

const NOW = new Date("2026-06-15T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => { await setAppLanguage("en"); });

describe("relativeTime, long (tables, cards, lists)", () => {
  it("rounds to the nearest unit and says ago", () => {
    expect(relativeTime(ago(10_000))).toBe("just now");
    expect([1, 2, 5, 21].map((n) => relativeTime(ago(n * MIN)))).toEqual(["1 min ago", "2 min ago", "5 min ago", "21 min ago"]);
    expect([1, 2, 5, 21].map((n) => relativeTime(ago(n * HOUR)))).toEqual(["1 hr ago", "2 hr ago", "5 hr ago", "21 hr ago"]);
    expect([1, 2, 5, 21].map((n) => relativeTime(ago(n * DAY)))).toEqual(["1 day ago", "2 days ago", "5 days ago", "21 days ago"]);
    expect([1, 2, 5].map((n) => relativeTime(ago(n * 30 * DAY)))).toEqual(["1 month ago", "2 months ago", "5 months ago"]);
    expect([1, 2, 5, 21].map((n) => relativeTime(ago(n * 365 * DAY)))).toEqual(["1 year ago", "2 years ago", "5 years ago", "21 years ago"]);
  });

  it("looks ahead to a moment still to come", () => {
    expect(relativeTime(ago(-6 * HOUR))).toBe("in 6 hr");
  });

  it("reads SQLite's zone-less timestamps as UTC, and says nothing for garbage", () => {
    expect(relativeTime("2026-06-15 11:55:00")).toBe("5 min ago");
    expect(relativeTime("not a date")).toBe("");
  });
});

describe("relativeTime, short (beside the author under a home tile)", () => {
  const short = (ms: number) => relativeTime(ago(ms), { style: "short" });

  it("counts whole units elapsed, in abbreviated units past a week", () => {
    expect(short(30_000)).toBe("just now");
    expect([1, 2, 5, 21].map((n) => short(n * MIN))).toEqual(["1 min ago", "2 min ago", "5 min ago", "21 min ago"]);
    expect([1, 2, 5, 21].map((n) => short(n * HOUR))).toEqual(["1 hr ago", "2 hr ago", "5 hr ago", "21 hr ago"]);
    expect(short(DAY + 2 * HOUR)).toBe("yesterday");
    expect([2, 5].map((n) => short(n * DAY))).toEqual(["2 days ago", "5 days ago"]);
    expect([7, 14, 28].map((n) => short(n * DAY))).toEqual(["1 wk ago", "2 wk ago", "4 wk ago"]);
    expect([35, 60, 150].map((n) => short(n * DAY))).toEqual(["1 mo ago", "2 mo ago", "5 mo ago"]);
    expect([1, 2, 5, 21].map((n) => short(n * 365 * DAY))).toEqual(["1 yr ago", "2 yr ago", "5 yr ago", "21 yr ago"]);
  });

  it("never looks ahead", () => {
    expect(short(-6 * HOUR)).toBe("just now");
  });
});

describe("relativeTime, compact (the activity feed's narrow column)", () => {
  const compact = (ms: number) => relativeTime(ago(ms), { style: "compact" });

  it("says it in the fewest words that are still true", () => {
    expect(compact(10_000)).toBe("just now");
    expect([1, 2, 5, 21].map((n) => compact(n * MIN))).toEqual(["1m", "2m", "5m", "21m"]);
    expect([1, 2, 5, 21].map((n) => compact(n * HOUR))).toEqual(["1h", "2h", "5h", "21h"]);
    expect(compact(26 * HOUR)).toBe("yesterday");
    expect([2, 5].map((n) => compact(n * DAY))).toEqual(["2 days", "5 days"]);
  });

  it("gives a date once a day count stops meaning anything", () => {
    expect(compact(21 * DAY)).toBe(new Date(ago(21 * DAY)).toLocaleDateString());
  });
});

describe("relativeTime in Russian", () => {
  beforeEach(async () => { await setAppLanguage("ru"); });
  afterEach(async () => { await setAppLanguage("en"); });

  it("long picks the right plural form", () => {
    expect(relativeTime(ago(10_000))).toBe("только что");
    expect([1, 2, 5, 21].map((n) => relativeTime(ago(n * MIN)))).toEqual(["1 мин назад", "2 мин назад", "5 мин назад", "21 мин назад"]);
    expect([1, 2, 5, 21].map((n) => relativeTime(ago(n * HOUR)))).toEqual(["1 ч назад", "2 ч назад", "5 ч назад", "21 ч назад"]);
    expect([1, 2, 5, 21].map((n) => relativeTime(ago(n * DAY)))).toEqual(["1 день назад", "2 дня назад", "5 дней назад", "21 день назад"]);
    expect([1, 2, 5].map((n) => relativeTime(ago(n * 30 * DAY)))).toEqual(["1 месяц назад", "2 месяца назад", "5 месяцев назад"]);
    expect([1, 2, 5, 21].map((n) => relativeTime(ago(n * 365 * DAY)))).toEqual(["1 год назад", "2 года назад", "5 лет назад", "21 год назад"]);
    expect(relativeTime(ago(-6 * HOUR))).toBe("через 6 ч");
  });

  it("short picks the right plural form", () => {
    const short = (ms: number) => relativeTime(ago(ms), { style: "short" });
    expect([1, 2, 5, 21].map((n) => short(n * MIN))).toEqual(["1 мин назад", "2 мин назад", "5 мин назад", "21 мин назад"]);
    expect(short(DAY + 2 * HOUR)).toBe("вчера");
    expect([2, 5].map((n) => short(n * DAY))).toEqual(["2 дня назад", "5 дней назад"]);
    expect([7, 14].map((n) => short(n * DAY))).toEqual(["1 нед. назад", "2 нед. назад"]);
    expect([35, 150].map((n) => short(n * DAY))).toEqual(["1 мес. назад", "5 мес. назад"]);
    expect([1, 2, 5, 21].map((n) => short(n * 365 * DAY))).toEqual(["1 год назад", "2 года назад", "5 лет назад", "21 год назад"]);
  });

  it("compact picks the right plural form", () => {
    const compact = (ms: number) => relativeTime(ago(ms), { style: "compact" });
    expect([1, 2, 5, 21].map((n) => compact(n * MIN))).toEqual(["1 мин", "2 мин", "5 мин", "21 мин"]);
    expect([1, 2, 5, 21].map((n) => compact(n * HOUR))).toEqual(["1 ч", "2 ч", "5 ч", "21 ч"]);
    expect(compact(26 * HOUR)).toBe("вчера");
    expect([2, 5].map((n) => compact(n * DAY))).toEqual(["2 дня", "5 дней"]);
  });
});
