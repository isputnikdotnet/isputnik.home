// The in-app changelog: what shipped in every release, newest first. This is
// product copy, not platform infrastructure, which is why it does not live in
// core/ alongside the route that serves it.
//
// The entries themselves are in changelog.json, beside this file — THAT is the
// file a release edits (a new entry goes at the top of its array). They used to be
// a literal in this file, 3,500 lines of data that tsc re-checked on every
// typecheck; now they are read once at boot, and this file is only the loader.
// `npm run build` copies the JSON into dist/ (scripts/copy-assets.mjs), and
// scripts/changelog-md.mjs renders the same file as CHANGELOG.md.
//
// Each entry is { version, label, changes[] }. Text may use two bits of Markdown —
// **bold** and `code` — which the About page renders (shared/AboutDetails.tsx).
// The file is checked as it loads: a malformed entry stops the boot (and every
// test that touches it) with the entry named, rather than rendering garbage.
//
// It is also large — a few hundred KB across 300-odd releases — and it used to
// be an inline literal inside the /api/about handler, so every visit to the
// About page downloaded the project's entire history to render the ten entries
// that fit on screen. /api/about now sends RECENT_VERSION_COUNT of these and the
// total; the rest are paged in from /api/about/changelog on demand.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface VersionUpdate {
  version: string;
  label: string;
  changes: string[];
}

/** How many releases /api/about sends inline — roughly one screen of timeline. */
export const RECENT_VERSION_COUNT = 10;

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const KEYS = ["version", "label", "changes"];

function compareVersions(a: string, b: string): number {
  const x = VERSION.exec(a)!.slice(1).map(Number);
  const y = VERSION.exec(b)!.slice(1).map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** Parse and check changelog.json's text. Throws, naming `source` and the entry,
 *  on anything that is not a newest-first list of well-formed releases. */
export function parseChangelog(text: string, source: string): VersionUpdate[] {
  const fail = (problem: string): never => {
    throw new Error(`${source}: ${problem}`);
  };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return fail(`not valid JSON (${(error as Error).message})`);
  }
  if (!Array.isArray(data) || data.length === 0) return fail("expected a non-empty array of releases");

  const updates: VersionUpdate[] = [];
  data.forEach((entry: unknown, index) => {
    const at = `entry ${index}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return fail(`${at} is not an object`);
    const record = entry as Record<string, unknown>;
    const extra = Object.keys(record).filter((key) => !KEYS.includes(key));
    if (extra.length) return fail(`${at} has unknown field(s) ${extra.join(", ")} — expected ${KEYS.join(", ")}`);
    const { version, label, changes } = record;
    if (typeof version !== "string" || !VERSION.test(version)) {
      return fail(`${at}: "version" must be a string like "4.0.0", got ${JSON.stringify(version)}`);
    }
    const named = `${at} (${version})`;
    if (typeof label !== "string" || !label.trim()) return fail(`${named}: "label" must be non-empty text`);
    if (!Array.isArray(changes) || changes.length === 0) return fail(`${named}: "changes" must be a non-empty array`);
    changes.forEach((change: unknown, n) => {
      if (typeof change !== "string" || !change.trim()) fail(`${named}: changes[${n}] must be non-empty text`);
    });
    const previous = updates[updates.length - 1];
    // Newest first is load-bearing: the About page pages from the top, and Home's
    // "what's new" note slices between two positions in this list.
    if (previous && compareVersions(previous.version, version) <= 0) {
      return fail(`${named} is listed below ${previous.version} but is not older than it — releases go newest first, each version once`);
    }
    updates.push({ version, label, changes: changes as string[] });
  });
  return updates;
}

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "changelog.json");

export const VERSION_UPDATES: VersionUpdate[] = parseChangelog(fs.readFileSync(file, "utf8"), file);
