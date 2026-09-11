// Every migration since the 3.0.0 baseline, in the order they run. The runner is
// ../migrate.ts; docs/database.md says when a change needs one of these at all.
//
// One file per migration, NNN-short-name.ts, each exporting its `version` and its
// `up(db)`. A new one is a new file here AND a line in the list below — a file
// missing from the list never runs (test/migrations-index.test.ts holds the two
// together). Versions only go up, one per released schema change; never renumber
// one or change its SQL once released: installs out there have already run it.
//
// Multi-line SQL inside backticks keeps the indentation it had when these lived in
// one array in migrate.ts. That whitespace is part of the string — and migration
// 55's CREATE TABLE text is stored verbatim in sqlite_master — so leave it be.
import type Database from "better-sqlite3";
import * as m033 from "./033-slideshow-title-card.js";
import * as m034 from "./034-alphabet-index.js";
import * as m035 from "./035-slideshow-cover.js";
import * as m036 from "./036-person-cover.js";
import * as m037 from "./037-session-kind-label.js";
import * as m038 from "./038-device-link-remote.js";
import * as m039 from "./039-login-attempt-kind.js";
import * as m040 from "./040-ip-reputation-origin.js";
import * as m041 from "./041-people-website-location.js";
import * as m042 from "./042-drop-empty-recycle-bin-job.js";
import * as m043 from "./043-slideshow-card-lettering.js";
import * as m044 from "./044-slideshow-closing-card.js";
import * as m045 from "./045-slideshow-clips.js";
import * as m046 from "./046-slideshow-clip-sound.js";
import * as m047 from "./047-retire-expanse-theme.js";
import * as m048 from "./048-user-language.js";
import * as m049 from "./049-quote-metadata.js";
import * as m050 from "./050-quote-import-run.js";
import * as m051 from "./051-people-life-facts.js";
import * as m052 from "./052-drop-opening-clip.js";
import * as m053 from "./053-slideshow-movie-target.js";
import * as m054 from "./054-share-link-expand-albums.js";
import * as m055 from "./055-gallery-audio-kind.js";
import * as m056 from "./056-story-chapter-pages.js";
import * as m057 from "./057-story-rating.js";
import * as m058 from "./058-story-collections.js";
import * as m059 from "./059-story-kinds.js";
import * as m060 from "./060-story-soft-delete.js";
import * as m061 from "./061-story-block-heading-map-cover.js";
import * as m062 from "./062-story-byline.js";
import * as m063 from "./063-route-leg-mode-geometry.js";
import * as m064 from "./064-scan-layouts.js";
import * as m065 from "./065-drop-scan-rule-pattern.js";
import * as m066 from "./066-story-published-at.js";
import * as m067 from "./067-recipe-facts.js";
import * as m068 from "./068-inbox-duplicate-check.js";
import * as m069 from "./069-drop-link-quotas.js";
import * as m070 from "./070-photo-review-fields.js";
import * as m071 from "./071-house-library.js";
import * as m072 from "./072-ask-for-notes.js";
import * as m073 from "./073-inbox-delivery-dismissed.js";
import * as m074 from "./074-music-track-asset.js";

export interface Migration {
  readonly version: number;
  up(db: Database.Database): void;
}

export const migrations: readonly Migration[] = [
  m033, m034, m035, m036, m037, m038, m039, m040, m041, m042,
  m043, m044, m045, m046, m047, m048, m049, m050, m051, m052,
  m053, m054, m055, m056, m057, m058, m059, m060, m061, m062,
  m063, m064, m065, m066, m067, m068, m069, m070, m071, m072,
  m073, m074
];
