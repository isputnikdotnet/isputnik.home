// How a photo's date reads once its precision is known (docs/photo-review-plan.md).
//
// `takenAt` is always a full instant; `takenPrecision` says how much of it a
// person actually knew — an old print is "1962", or "July 1962", or "the 1950s",
// and "about" in front of any of them. Everywhere a date is shown goes through
// `formatTakenDate` so the Timeline, the Info panel and Review mode agree; the
// three input helpers keep the edit forms in step with the server's flooring
// (modules/library/gallery/taken-precision.ts).
import i18n from "../../i18n";

export type TakenPrecision = "time" | "day" | "month" | "year" | "decade";
export const TAKEN_PRECISIONS: TakenPrecision[] = ["time", "day", "month", "year", "decade"];

interface TakenLike {
  takenAt: string | null;
  takenPrecision?: TakenPrecision;
  takenApprox?: boolean;
}

/** UTC year/month/day off the ISO prefix — a coarse date is stored as the
 *  period's first UTC instant, and reading it in local time could roll "1962"
 *  back to New Year's Eve 1961 west of Greenwich. */
function utcParts(iso: string): { y: number; m: number; d: number } | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!parts) return null;
  return { y: Number(parts[1]), m: Number(parts[2]), d: Number(parts[3]) };
}

/** The date as a person would say it: "14 Jul 1962, 15:30" for an exact one,
 *  "July 1962" for a month, "1962" for a year, "1950s" for a decade, with
 *  "around" in front when it was only ever approximate. `withTime` adds the
 *  clock to an exact date (the Info panel wants it, a heading does not). */
export function formatTakenDate(asset: TakenLike, opts: { withTime?: boolean; long?: boolean } = {}): string {
  if (!asset.takenAt) return "";
  const precision = asset.takenPrecision ?? "time";
  const monthStyle = opts.long ? "long" : "short";
  let text = "";
  if (precision === "time" || precision === "day") {
    const d = new Date(asset.takenAt);
    if (Number.isNaN(d.getTime())) return "";
    text = precision === "time" && opts.withTime
      ? d.toLocaleString(undefined, { year: "numeric", month: monthStyle, day: "numeric", hour: "2-digit", minute: "2-digit" })
      : precision === "time"
        ? d.toLocaleDateString(undefined, { year: "numeric", month: monthStyle, day: "numeric" })
        // A day-precise date is stored at UTC midnight; read it as a calendar day.
        : new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).toLocaleDateString(undefined, { year: "numeric", month: monthStyle, day: "numeric" });
  } else {
    const parts = utcParts(asset.takenAt);
    if (!parts) return "";
    if (precision === "month") {
      text = new Date(parts.y, parts.m - 1, 1).toLocaleDateString(undefined, { year: "numeric", month: "long" });
    } else if (precision === "year") {
      text = String(parts.y);
    } else {
      text = i18n.t("gallery:date.decade", { year: Math.floor(parts.y / 10) * 10 });
    }
  }
  return asset.takenApprox ? i18n.t("gallery:date.around", { date: text }) : text;
}

/** The <input type> that edits a date at this precision. */
export function takenInputType(precision: TakenPrecision): "datetime-local" | "date" | "month" | "number" {
  if (precision === "time") return "datetime-local";
  if (precision === "day") return "date";
  if (precision === "month") return "month";
  return "number";
}

/** A stored date as the value of the input `takenInputType` names. */
export function takenInputValue(takenAt: string | null, precision: TakenPrecision): string {
  if (!takenAt) return "";
  if (precision === "time") {
    const d = new Date(takenAt);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const parts = utcParts(takenAt);
  if (!parts) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  if (precision === "day") return `${parts.y}-${pad(parts.m)}-${pad(parts.d)}`;
  if (precision === "month") return `${parts.y}-${pad(parts.m)}`;
  return String(precision === "decade" ? Math.floor(parts.y / 10) * 10 : parts.y);
}

/** An input's value back to the ISO instant the server stores (it floors to the
 *  period itself, so a day is sent at UTC midnight and a year on 1 January).
 *  Null for an empty or unusable value. */
export function takenInputToIso(value: string, precision: TakenPrecision): string | null {
  const v = value.trim();
  if (!v) return null;
  if (precision === "time") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const iso = precision === "day" ? `${v}T00:00:00.000Z`
    : precision === "month" ? `${v}-01T00:00:00.000Z`
      : /^\d{1,4}$/.test(v) ? `${v.padStart(4, "0")}-01-01T00:00:00.000Z` : "";
  return iso && !Number.isNaN(new Date(iso).getTime()) ? iso : null;
}

/** Option labels for a precision picker, in the order a person narrows down. */
export function precisionLabel(precision: TakenPrecision): string {
  return i18n.t(`gallery:date.precision.${precision}`);
}
