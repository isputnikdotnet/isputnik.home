import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const here = path.dirname(fileURLToPath(import.meta.url));

// The whole schema lives in schema.sql and is idempotent (CREATE TABLE IF NOT
// EXISTS), so a database is built in one pass with no migration history to replay.
//
// `migrations` is empty, and has been reset twice now. 2.0.0 folded 2-22 back into
// schema.sql; 3.0.0 folds 24-31 the same way, because 3.0.0 does not upgrade an
// earlier database at all — it is a fresh install, so a chain of ALTER TABLEs against
// a 2.x file is code that can never run. It grows again only when a RELEASED 3.x
// schema has to change in a way schema.sql alone cannot apply to existing data: a new
// column on an existing table, or a widened CHECK.
const baseline = 32;

// 3.0.0 starts from an empty database. 31 is the last 2.x schema and is structurally
// identical to a fresh 3.0.0 one — every column and table matches — so it adopts the
// new baseline untouched. Anything older is missing columns nothing here can add back,
// so it stops the server rather than failing later at a query.
const LAST_LEGACY_VERSION = 31;

const migrations: { version: number; up: (db: Database.Database) => void }[] = [
  {
    // 3.2.0 — title-card options for slideshow movies. New columns on an existing
    // table, so schema.sql alone can't reach a database that already has one. The
    // defaults are exactly the card 3.1.x rendered (the slideshow's name over black,
    // three seconds, a photo-count subline), so an existing slideshow re-renders the
    // same movie until someone changes something.
    version: 33,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(gallery_slideshows)").all() as { name: string }[]).map((c) => c.name)
      );
      const add = (name: string, definition: string) => {
        if (!columns.has(name)) db.exec(`ALTER TABLE gallery_slideshows ADD COLUMN ${name} ${definition}`);
      };
      add("title_enabled", "INTEGER NOT NULL DEFAULT 1");
      add("title_text", "TEXT");
      add("title_subtitle_mode", "TEXT NOT NULL DEFAULT 'count' CHECK (title_subtitle_mode IN ('count', 'custom', 'none'))");
      add("title_subtitle", "TEXT");
      add("title_seconds", "REAL NOT NULL DEFAULT 3");
      add("title_background", "TEXT NOT NULL DEFAULT 'black' CHECK (title_background IN ('black', 'photo', 'blur', 'collage'))");
      add("title_photo_item_id", "TEXT REFERENCES library_items(id) ON DELETE SET NULL");
    }
  },
  {
    // 3.4.0 — the alphabet index behind the A–Z strip. New columns on
    // item_metadata, so schema.sql alone can't reach an existing database. They
    // land empty: the values can only be computed in JS (SQLite's UPPER is
    // ASCII-only, and there is no custom-collation API), so backfillAlphaKeys()
    // in modules/library/shared/alphabet-index.ts fills them at startup —
    // keeping product logic out of the migration runner.
    version: 34,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(item_metadata)").all() as { name: string }[]).map((c) => c.name)
      );
      for (const name of ["alpha_key", "alpha_script", "alpha_override", "sort_key"]) {
        if (!columns.has(name)) db.exec(`ALTER TABLE item_metadata ADD COLUMN ${name} TEXT`);
      }
    }
  },
  {
    // 3.4.3 — an explicit cover for a slideshow (mirrors gallery_albums.cover_item_id),
    // rather than always the first slide. New column on an existing table, so
    // schema.sql alone can't reach a database that already has one.
    version: 35,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(gallery_slideshows)").all() as { name: string }[]).map((c) => c.name)
      );
      if (!columns.has("cover_item_id")) {
        db.exec("ALTER TABLE gallery_slideshows ADD COLUMN cover_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL");
      }
    }
  },
  {
    // 3.4.4 — the same explicit cover pick for a person. New column on an existing
    // table, so schema.sql alone can't reach a database that already has one.
    version: 36,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(gallery_people)").all() as { name: string }[]).map((c) => c.name)
      );
      if (!columns.has("cover_item_id")) {
        db.exec("ALTER TABLE gallery_people ADD COLUMN cover_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL");
      }
    }
  },
  {
    // 3.5.0 — link a device. A session now knows whether it was minted by someone
    // typing a password or by a display being linked from a phone, and carries the
    // name its owner gave it. New columns on an existing table, so schema.sql alone
    // can't reach a database that already has one.
    //
    // Both land on every existing session as 'browser' with no label, which is
    // exactly what those sessions are: the CHECK and the DEFAULT together mean an
    // upgraded install has nothing to backfill.
    version: 37,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name)
      );
      if (!columns.has("kind")) {
        db.exec(
          "ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'browser' CHECK (kind IN ('browser', 'device'))"
        );
      }
      if (!columns.has("label")) {
        db.exec("ALTER TABLE sessions ADD COLUMN label TEXT");
      }
    }
  },
  {
    // 3.6.0 — linking a device from outside the house, during a registration
    // window an admin opens for one person (device_link_windows, which schema.sql
    // creates on its own). A request now remembers whether it came from outside,
    // because the approval step can't work it out later: by then the caller is the
    // phone, not the display. New column on an existing table.
    //
    // Existing rows default to 0 — not remote — which is what every request made
    // before 3.6.0 was: 3.5.0 refused them all.
    version: 38,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(device_link_requests)").all() as { name: string }[]).map((c) => c.name)
      );
      if (!columns.has("remote")) {
        db.exec("ALTER TABLE device_link_requests ADD COLUMN remote INTEGER NOT NULL DEFAULT 0 CHECK (remote IN (0, 1))");
      }
    }
  },
  {
    // 3.8.0 — why an IP was auto-blocked. A failed row now says what it was —
    // 'signin' (a password, code, or passkey), 'probe' (a scanner path sweep),
    // or 'token' (a share/API token or device code matching nothing) — so the
    // block reason and the admin alert can tell scanner noise from a password
    // attack. New column on an existing table. Existing rows default to
    // 'signin', which is what the block reason has always called them.
    version: 39,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(login_attempts)").all() as { name: string }[]).map((c) => c.name)
      );
      if (!columns.has("kind")) {
        db.exec(
          "ALTER TABLE login_attempts ADD COLUMN kind TEXT NOT NULL DEFAULT 'signin' CHECK (kind IN ('signin', 'probe', 'token'))"
        );
      }
    }
  },
  {
    // 3.11.0 — where a flagged address sits. AbuseIPDB already returns the country
    // and ISP with every check; storing them lets the Logins table say "US ·
    // DigitalOcean" beside a score without a second lookup.
    version: 40,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(ip_reputation)").all() as { name: string }[]).map((c) => c.name)
      );
      if (!columns.has("country_code")) {
        db.exec("ALTER TABLE ip_reputation ADD COLUMN country_code TEXT");
      }
      if (!columns.has("isp")) {
        db.exec("ALTER TABLE ip_reputation ADD COLUMN isp TEXT");
      }
    }
  },
  {
    // 3.24.0 — a website and a location on an author/narrator profile, shown
    // beside their bio. New columns on an existing table, so schema.sql alone
    // can't reach a database that already has one.
    version: 41,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(people)").all() as { name: string }[]).map((c) => c.name)
      );
      if (!columns.has("website")) {
        db.exec("ALTER TABLE people ADD COLUMN website TEXT");
      }
      if (!columns.has("location")) {
        db.exec("ALTER TABLE people ADD COLUMN location TEXT");
      }
    }
  },
  {
    // 3.25.0 — the "Empty recycle bin" scheduled job is gone, replaced by
    // "purge_expired_trash". It emptied the entire bin on a cadence regardless of
    // retention, and it shipped enabled, so an install that never chose it lost
    // hand-deleted items a week after deleting them — the 30-day window it sat
    // beside was never reached. Drop the row: no definition answers to that key
    // any more, and the enabled flag on it was seeded rather than asked for. An
    // admin who genuinely wants the whole bin cleared still has the button on the
    // Recycle Bin page. Not something schema.sql can do — it is stored state.
    version: 42,
    up: (db) => {
      db.prepare("DELETE FROM scheduled_jobs WHERE key = 'empty_recycle_bin'").run();
    }
  },
  {
    // 3.26.0 — lettering for the slideshow movie's title card: which bundled face
    // the text is set in and how large. New columns on an existing table, so
    // schema.sql alone can't reach a database that already has one. The defaults
    // are exactly what every earlier movie rendered (DejaVu Sans at today's size),
    // so an untouched slideshow re-renders the same card.
    version: 43,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(gallery_slideshows)").all() as { name: string }[]).map((c) => c.name)
      );
      const add = (name: string, definition: string) => {
        if (!columns.has(name)) db.exec(`ALTER TABLE gallery_slideshows ADD COLUMN ${name} ${definition}`);
      };
      add("card_font", "TEXT NOT NULL DEFAULT 'classic' CHECK (card_font IN ('classic', 'serif', 'bold', 'script', 'typewriter'))");
      add("card_size", "TEXT NOT NULL DEFAULT 'medium' CHECK (card_size IN ('small', 'medium', 'large'))");
    }
  },
  {
    // 3.26.0 — the movie's closing card: an end title ("The End" unless renamed),
    // up to six lines of credits, its own length and background, and the music
    // fading out underneath it. New columns on an existing table, so schema.sql
    // alone can't reach a database that already has one. closing_enabled defaults
    // OFF — an untouched slideshow renders exactly the movie it always did.
    version: 44,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(gallery_slideshows)").all() as { name: string }[]).map((c) => c.name)
      );
      const add = (name: string, definition: string) => {
        if (!columns.has(name)) db.exec(`ALTER TABLE gallery_slideshows ADD COLUMN ${name} ${definition}`);
      };
      add("closing_enabled", "INTEGER NOT NULL DEFAULT 0");
      add("closing_text", "TEXT");
      add("closing_lines", "TEXT");
      add("closing_seconds", "REAL NOT NULL DEFAULT 5");
      add("closing_background", "TEXT NOT NULL DEFAULT 'black' CHECK (closing_background IN ('black', 'photo', 'blur', 'collage'))");
      add("closing_photo_item_id", "TEXT REFERENCES library_items(id) ON DELETE SET NULL");
    }
  },
  {
    // 3.26.0 — opening and closing clips: a gallery video that plays before the
    // title card (a home-video "studio logo") and/or after the slides, before the
    // closing card. Any accessible gallery video, not just slideshow members; a
    // deleted item clears itself (SET NULL), and the render skips a clip it can't
    // reach rather than failing. New columns on an existing table.
    version: 45,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(gallery_slideshows)").all() as { name: string }[]).map((c) => c.name)
      );
      for (const name of ["intro_item_id", "outro_item_id"]) {
        if (!columns.has(name)) {
          db.exec(`ALTER TABLE gallery_slideshows ADD COLUMN ${name} TEXT REFERENCES library_items(id) ON DELETE SET NULL`);
        }
      }
    }
  },
  {
    // 3.26.0 — a clip's own sound. An intro/outro clip is often chosen FOR its
    // sound (a recorded greeting, a toast), so each clip carries a per-clip
    // toggle, on by default: the clip's audio plays and the music pauses under
    // it, resuming where it left off. New columns on an existing table.
    version: 46,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(gallery_slideshows)").all() as { name: string }[]).map((c) => c.name)
      );
      for (const name of ["intro_sound", "outro_sound"]) {
        if (!columns.has(name)) {
          db.exec(`ALTER TABLE gallery_slideshows ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 1`);
        }
      }
    }
  },
  {
    // 3.30.0 — the Expanse theme is retired; Plain Dark took over its palette, so
    // accounts (and a stored install default) pointing at it land on the theme that
    // now looks the way they chose. "hard-orbit" was Expanse's pre-release name,
    // until now remapped at read time rather than in the data.
    version: 47,
    up: (db) => {
      db.prepare("UPDATE users SET theme = 'plain-dark' WHERE theme IN ('expanse', 'hard-orbit')").run();
      db.prepare(
        "UPDATE app_settings SET value = 'plain-dark' WHERE key = 'default_theme' AND value IN ('expanse', 'hard-orbit')"
      ).run();
    }
  },
  {
    // 3.31.0 — per-user interface language (i18n). A new column on an existing
    // table, so schema.sql alone can't reach a database that already has one.
    // Everyone starts on English, the language the UI has always been.
    version: 48,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name)
      );
      if (!columns.has("language")) {
        db.exec("ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'en'");
      }
    }
  },
  {
    // 3.32.0 — the metadata a quote needs to be more than a reading highlight:
    // where it came from, who may see it, whether it joins the Quote-of-the-day
    // rotation, and language/date/context. The family-tree speaker link lands in
    // the same pass so the table is only rewritten once, though nothing reads it
    // until the profile work. New columns on an existing table, so schema.sql
    // alone can't reach a database that already has one.
    version: 49,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(quotes)").all() as { name: string }[]).map((c) => c.name)
      );
      const add = (name: string, definition: string) => {
        if (!columns.has(name)) db.exec(`ALTER TABLE quotes ADD COLUMN ${name} ${definition}`);
      };
      add("origin", "TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'reader', 'import'))");
      add("visibility", "TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'family'))");
      add("in_rotation", "INTEGER NOT NULL DEFAULT 0");
      add("language", "TEXT");
      add("quote_date", "TEXT");
      add("context", "TEXT");
      add("family_tree_person_id", "TEXT REFERENCES family_tree_persons(id) ON DELETE SET NULL");
      add("person_name", "TEXT");
      // Existing rows predate `origin` and land on its 'manual' default, which is
      // right for hand-typed quotes but wrong for the ones the reader captured —
      // and a document anchor is exactly what identifies those.
      db.prepare("UPDATE quotes SET origin = 'reader' WHERE document_id IS NOT NULL").run();
      // The daily card's pool lookup. This index cannot live in schema.sql: that
      // file is executed in full BEFORE these migrations run, so an index over a
      // column this migration has yet to add would throw on every upgrade. Move
      // it there when migrations are next folded back into the baseline.
      db.exec("CREATE INDEX IF NOT EXISTS idx_quotes_rotation ON quotes(visibility, user_id) WHERE in_rotation = 1");
    }
  },
  {
    // 3.33.0 — remember which import run brought a quote in, so one pack can be
    // undone without touching another. The quote_imports table is new, so
    // schema.sql creates it unaided; this is only the column on the released
    // quotes table. Quotes imported before this have no run to belong to and
    // stay reachable through "delete all imported", exactly as they were.
    version: 50,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(quotes)").all() as { name: string }[]).map((c) => c.name)
      );
      if (!columns.has("import_id")) {
        db.exec("ALTER TABLE quotes ADD COLUMN import_id TEXT REFERENCES quote_imports(id) ON DELETE SET NULL");
      }
      // Same reason as the rotation index above: schema.sql runs before this.
      db.exec("CREATE INDEX IF NOT EXISTS idx_quotes_import ON quotes(import_id) WHERE import_id IS NOT NULL");
    }
  }
];

function userVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

export function migrate(db: Database.Database): void {
  // 0 = a brand-new file; schema.sql below builds it complete.
  const existing = userVersion(db);
  if (existing > 0 && existing < LAST_LEGACY_VERSION) {
    throw new Error(
      `This database is from an older version (schema ${existing}). 3.0.0 is a new install rather than an upgrade, ` +
      "so it cannot be carried across. Start from an empty database — libraries rescan from their files. " +
      "Export the family tree as GEDCOM first: it is the one thing that cannot be rebuilt from disk."
    );
  }

  const schema = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
  db.exec(schema);

  if (userVersion(db) < baseline) {
    db.pragma(`user_version = ${baseline}`);
  }

  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (userVersion(db) < m.version) {
      db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      })();
    }
  }
}
