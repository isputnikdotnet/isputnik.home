// Back sides of scanned prints — the pairing rule, pure (docs/back-sides-proposal.md).
//
// A print scanned on both sides is ONE photo: the back is recorded on the front's
// gallery_details row and never catalogued as a photo of its own. The two files sit
// in the same folder and are paired BY NAME: a pattern like `{name}_b` says which
// file is the back of which. Never by time — a back can be scanned a quarter of an
// hour after its front — and never across folders.
//
// This module decides pairs from file names alone; the scanner, the upload route
// and the explicit "Add the back" action all ask it the same questions.
import path from "node:path";
import {
  enabledBackPatterns,
  epsonTwinRule,
  type BackSidesSettings
} from "../shared/library-settings.js";
import type { AssetKind } from "./media.js";

/** The rule in force for one library: patterns in order, plus the Epson twin rule. */
export interface BackRule {
  patterns: string[];
  /** The Epson preset is on: a back whose plain front is gone attaches to the
   *  `_a` enhanced copy instead, and a deleted front hands its back to that twin. */
  epsonTwin: boolean;
}

export function backRuleOf(settings: BackSidesSettings): BackRule {
  return { patterns: enabledBackPatterns(settings), epsonTwin: epsonTwinRule(settings) };
}

export const NO_RULE: BackRule = { patterns: [], epsonTwin: false };

/** What the explicit actions name a back when the library has no pattern on. */
const FALLBACK_PATTERN = "{name}_back";

const PLACEHOLDER = "{name}";

function splitPattern(pattern: string): { prefix: string; suffix: string } {
  const at = pattern.indexOf(PLACEHOLDER);
  if (at < 0) return { prefix: "", suffix: pattern };
  return { prefix: pattern.slice(0, at), suffix: pattern.slice(at + PLACEHOLDER.length) };
}

/** The front's stem a file stem names under `pattern`, in the file's own case, or
 *  null when the stem does not fit. `IMG_0012_b` + `{name}_b` → `IMG_0012`. */
export function matchBackPattern(stem: string, pattern: string): string | null {
  const { prefix, suffix } = splitPattern(pattern);
  const lower = stem.toLowerCase();
  const pre = prefix.toLowerCase();
  const suf = suffix.toLowerCase();
  if (stem.length <= prefix.length + suffix.length) return null;
  if (!lower.startsWith(pre) || !lower.endsWith(suf)) return null;
  return stem.slice(prefix.length, stem.length - suffix.length);
}

export interface PairCandidate {
  relativePath: string;
  kind: AssetKind;
}

export interface BackPairing {
  /** Front relative path → its back's relative path. */
  backOf: Map<string, string>;
  /** Every relative path that is a back (and so is not an item). */
  backs: Set<string>;
  /** Files that fit a pattern but have no front beside them: ordinary photos. */
  unmatched: string[];
}

function stemOf(relativePath: string): string {
  const base = path.posix.basename(relativePath);
  return base.slice(0, base.length - path.posix.extname(base).length);
}

/** Pair backs with fronts across a file list, folder by folder. A candidate is a
 *  back only when the same folder holds a photo with the stem its pattern names,
 *  both are photos, and that front is not itself a back. Patterns are tried in
 *  order; the first back a front gets is the one it keeps. */
export function pairBackSides(files: PairCandidate[], rule: BackRule): BackPairing {
  const backOf = new Map<string, string>();
  const backs = new Set<string>();
  const unmatched: string[] = [];
  if (rule.patterns.length === 0) return { backOf, backs, unmatched };

  const byDir = new Map<string, PairCandidate[]>();
  for (const file of files) {
    if (file.kind !== "photo") continue;
    const dir = path.posix.dirname(file.relativePath);
    const list = byDir.get(dir);
    if (list) list.push(file); else byDir.set(dir, [file]);
  }

  for (const list of byDir.values()) {
    list.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
    const byStem = new Map<string, PairCandidate>();
    for (const file of list) {
      const key = stemOf(file.relativePath).toLowerCase();
      if (!byStem.has(key)) byStem.set(key, file);
    }
    const frontsFor = (file: PairCandidate, pattern: string): PairCandidate[] => {
      const frontStem = matchBackPattern(stemOf(file.relativePath), pattern);
      if (frontStem === null) return [];
      const candidates = rule.epsonTwin ? [frontStem, `${frontStem}_a`] : [frontStem];
      return candidates
        .map((candidate) => byStem.get(candidate.toLowerCase()))
        .filter((front): front is PairCandidate => Boolean(front) && front!.relativePath !== file.relativePath);
    };
    // First: which files are backs at all — a file whose name fits a pattern AND
    // whose front is beside it. Decided before any pairing, so that `X_b` is a
    // back of `X` whatever order the folder lists them in, and can never be the
    // front of `X_b_b`.
    const claimed = new Set<string>();
    for (const pattern of rule.patterns) {
      for (const file of list) {
        if (claimed.has(file.relativePath)) continue;
        if (frontsFor(file, pattern).some((front) => !claimed.has(front.relativePath))) claimed.add(file.relativePath);
      }
    }
    const seenUnmatched = new Set<string>();
    for (const pattern of rule.patterns) {
      for (const file of list) {
        if (backs.has(file.relativePath) || backOf.has(file.relativePath)) continue;
        const fronts = frontsFor(file, pattern);
        if (fronts.length === 0 && matchBackPattern(stemOf(file.relativePath), pattern) === null) continue;
        let paired = false;
        for (const front of fronts) {
          if (claimed.has(front.relativePath) || backs.has(front.relativePath) || backOf.has(front.relativePath)) continue;
          backOf.set(front.relativePath, file.relativePath);
          backs.add(file.relativePath);
          paired = true;
          break;
        }
        if (!paired && !seenUnmatched.has(file.relativePath)) {
          seenUnmatched.add(file.relativePath);
          unmatched.push(file.relativePath);
        }
      }
    }
  }
  // A file that fit a pattern under one rule but was paired under a later one is
  // not unmatched after all.
  return { backOf, backs, unmatched: unmatched.filter((relativePath) => !backs.has(relativePath)) };
}

/** The fronts a back file could belong to, by stem, in the order to try them:
 *  what the single-file paths ask when a `_b` lands alone. */
export function frontStemsFor(backRelativePath: string, rule: BackRule): string[] {
  const stem = stemOf(backRelativePath);
  const out: string[] = [];
  for (const pattern of rule.patterns) {
    const frontStem = matchBackPattern(stem, pattern);
    if (frontStem === null) continue;
    if (!out.includes(frontStem)) out.push(frontStem);
    if (rule.epsonTwin && !out.includes(`${frontStem}_a`)) out.push(`${frontStem}_a`);
  }
  return out;
}

/** What a back added by hand is named: the library's first pattern, else
 *  `{name}_back`, over the front's stem, with the back's own extension. */
export function backFileNameFor(frontFileName: string, rule: BackRule, backExtension: string): string {
  const pattern = rule.patterns[0] ?? FALLBACK_PATTERN;
  const stem = frontFileName.slice(0, frontFileName.length - path.posix.extname(frontFileName).length);
  const ext = backExtension.startsWith(".") ? backExtension : `.${backExtension}`;
  return `${pattern.replace(PLACEHOLDER, stem)}${ext.toLowerCase()}`;
}

/** The name a split-off back takes: `<front stem> (back).<ext>` — deliberately
 *  not a form any pattern recognises, so a rescan leaves it an ordinary photo. */
export function splitFileNameFor(frontFileName: string, backFileName: string): string {
  const stem = frontFileName.slice(0, frontFileName.length - path.posix.extname(frontFileName).length);
  return `${stem} (back)${path.posix.extname(backFileName).toLowerCase()}`;
}

/** The twin of a front under the Epson rule: `X` ↔ `X_a`, same folder, same
 *  extension family. Where a deleted front's back goes. Null when the rule is off
 *  or the name has no twin shape. */
export function epsonTwinStemOf(relativePath: string): string | null {
  const stem = stemOf(relativePath);
  if (/_a$/i.test(stem)) return stem.slice(0, -2);
  return `${stem}_a`;
}
