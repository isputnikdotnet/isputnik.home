// A book folder's metadata.json sidecar (our own shape or Audiobookshelf's).
import fs from "node:fs";
import path from "node:path";
import type { TagEncoding } from "../../shared/library-settings.js";
import { repairEncoding, repairList, splitTagValues, stringValue } from "./tag-read.js";

interface SidecarMetadata {
  title?: string;
  subtitle?: string;
  authors?: string[];
  narrators?: string[];
  publisher?: string;
  year?: number;
  yearPublished?: number;
  description?: string;
  isbn?: string;
  asin?: string;
  genres?: string[];
  language?: string;
  series?: string;
  seriesName?: string;
  seriesPosition?: number;
}

type SidecarStringField = "title" | "subtitle" | "description" | "publisher" | "isbn" | "asin" | "language";

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : undefined;
}

function yearValue(value: unknown): number | undefined {
  const year = numberValue(value);
  return year && year > 0 ? Math.trunc(year) : undefined;
}

function applyStringField(target: SidecarMetadata, key: SidecarStringField, value: unknown) {
  const text = stringValue(value);
  if (text) {
    target[key] = text;
  }
}

function seriesValue(value: unknown): { name?: string; position?: number } {
  if (Array.isArray(value)) {
    for (const item of value) {
      const series = seriesValue(item);
      if (series.name) {
        return series;
      }
    }
    return {};
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const name = stringValue(record.name)
      ?? stringValue(record.title)
      ?? stringValue(record.seriesName)
      ?? stringValue(record.series);
    const position = numberValue(record.sequence)
      ?? numberValue(record.position)
      ?? numberValue(record.seriesPosition);
    return {
      ...(name ? { name } : {}),
      ...(position !== undefined ? { position } : {})
    };
  }

  const raw = stringValue(value);
  if (!raw) return {};
  const match = raw.match(/^(.+?)\s*#\s*(\d+(?:\.\d+)?)\s*$/);
  if (match) {
    return { name: match[1].trim(), position: parseFloat(match[2]) };
  }
  return { name: raw };
}

function normaliseSidecar(raw: Record<string, unknown>): SidecarMetadata {
  const isAbs = typeof raw.authorName === "string" || typeof raw.narratorName === "string";
  if (!isAbs) {
    const result: SidecarMetadata = {};
    applyStringField(result, "title", raw.title);
    applyStringField(result, "subtitle", raw.subtitle);
    applyStringField(result, "description", raw.description);
    applyStringField(result, "publisher", raw.publisher);
    applyStringField(result, "isbn", raw.isbn);
    applyStringField(result, "asin", raw.asin);
    applyStringField(result, "language", raw.language);

    const authors = sidecarArray(raw.authors);
    if (authors.length > 0) result.authors = authors;
    const narrators = sidecarArray(raw.narrators);
    if (narrators.length > 0) result.narrators = narrators;
    const genres = sidecarArray(raw.genres);
    if (genres.length > 0) result.genres = genres;

    const year = yearValue(raw.year);
    if (year !== undefined) result.year = year;
    const yearPublished = yearValue(raw.yearPublished);
    if (yearPublished !== undefined) result.yearPublished = yearPublished;

    const series = seriesValue(raw.series);
    if (series.name) result.series = series.name;
    const seriesName = seriesValue(raw.seriesName);
    if (seriesName.name) result.seriesName = seriesName.name;
    const seriesPosition = numberValue(raw.seriesPosition)
      ?? seriesName.position
      ?? series.position
      ?? numberValue(raw.sequence);
    if (seriesPosition !== undefined) result.seriesPosition = seriesPosition;

    return result;
  }

  const result: SidecarMetadata = {};
  applyStringField(result, "title", raw.title);
  applyStringField(result, "subtitle", raw.subtitle);
  applyStringField(result, "description", raw.description);
  applyStringField(result, "language", raw.language);
  applyStringField(result, "isbn", raw.isbn);
  applyStringField(result, "asin", raw.asin);

  if (typeof raw.authorName === "string" && raw.authorName.trim()) {
    result.authors = splitTagValues([raw.authorName]);
  }
  if (typeof raw.narratorName === "string" && raw.narratorName.trim()) {
    result.narrators = splitTagValues([raw.narratorName]);
  }

  if (raw.publishedYear != null) {
    const y = yearValue(raw.publishedYear);
    if (y !== undefined) result.year = y;
  } else if (typeof raw.publishedDate === "string") {
    const m = raw.publishedDate.match(/\d{4}/);
    if (m) result.year = Number(m[0]);
  }

  const genres = sidecarArray(raw.genres);
  if (genres.length > 0) result.genres = genres;

  const series = seriesValue(raw.series);
  if (series.name) result.series = series.name;
  if (series.position !== undefined) {
    result.seriesPosition = series.position;
  }

  if (result.seriesPosition === undefined && raw.sequence != null) {
    const pos = numberValue(raw.sequence);
    if (pos !== undefined) result.seriesPosition = pos;
  }

  return result;
}

export function readSidecarMetadata(folderPath: string) {
  const filePath = path.join(folderPath, "metadata.json");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }

  try {
    return normaliseSidecar(JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export function sidecarArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) {
    return splitTagValues([value]);
  }
  return [];
}

// Sidecar values take precedence over audio tags, so the encoding fix must also
// repair mojibake stored inside a metadata.json (e.g. "title": "wap-version ÌÄÑ").
export function repairSidecar(sidecar: SidecarMetadata | null, encoding: TagEncoding | undefined): SidecarMetadata | null {
  if (!sidecar || !encoding) {
    return sidecar;
  }
  const fix = (value: string | undefined) => (value == null ? value : repairEncoding(value, encoding) ?? value);
  return {
    ...sidecar,
    title: fix(sidecar.title),
    subtitle: fix(sidecar.subtitle),
    description: fix(sidecar.description),
    publisher: fix(sidecar.publisher),
    language: fix(sidecar.language),
    series: fix(sidecar.series),
    seriesName: fix(sidecar.seriesName),
    authors: sidecar.authors ? repairList(sidecar.authors, encoding) : sidecar.authors,
    narrators: sidecar.narrators ? repairList(sidecar.narrators, encoding) : sidecar.narrators,
    genres: sidecar.genres ? repairList(sidecar.genres, encoding) : sidecar.genres
  };
}
