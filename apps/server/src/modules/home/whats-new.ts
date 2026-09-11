// "Updated to X — what changed": after an upgrade, Home tells each person once
// which releases arrived since they last looked, with the headline of each, and
// links to the full notes on the About page. The releases themselves are the
// in-app changelog (changelog.ts); what each person has seen is one row in
// user_seen_versions.
//
// A person with no row is either brand new — nothing to announce, they have never
// seen the app before this version — or an account from before this existed, who
// is told about the current release only. "New" is an account under a week old.
import type { FastifyInstance } from "fastify";
import { db } from "../../db.js";
import { config } from "../../config.js";
import { VERSION_UPDATES, type VersionUpdate } from "../../changelog.js";

/** At most this many release headlines in the note; the About page has the rest. */
const MAX_RELEASES = 5;
const NEW_ACCOUNT_DAYS = 7;

function markSeen(userId: string, version: string): void {
  db.prepare(`
    INSERT INTO user_seen_versions (user_id, version) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET version = excluded.version, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(userId, version);
}

/** The releases this person hasn't been told about, newest first (possibly none). */
export function unseenReleases(userId: string, accountCreatedAt: string, current = config.version): { releases: VersionUpdate[]; total: number } {
  const row = db.prepare("SELECT version FROM user_seen_versions WHERE user_id = ?").get(userId) as { version: string } | undefined;
  const currentIndex = VERSION_UPDATES.findIndex((update) => update.version === current);
  // A build whose own version has no changelog entry (a dev tree mid-release) has
  // nothing to say, and must not record a version the list can't place later.
  if (currentIndex === -1) return { releases: [], total: 0 };
  if (!row) {
    const ageDays = (Date.now() - new Date(accountCreatedAt).getTime()) / 86_400_000;
    if (!(ageDays > NEW_ACCOUNT_DAYS)) {
      markSeen(userId, current);
      return { releases: [], total: 0 };
    }
    return { releases: [VERSION_UPDATES[currentIndex]], total: 1 };
  }
  if (row.version === current) return { releases: [], total: 0 };
  const seenIndex = VERSION_UPDATES.findIndex((update) => update.version === row.version);
  // Newest first: everything above the seen entry is new. A seen version the list
  // doesn't know (a downgrade, a renamed entry) gets the current release only.
  const unseen = seenIndex > currentIndex ? VERSION_UPDATES.slice(currentIndex, seenIndex) : [VERSION_UPDATES[currentIndex]];
  return { releases: unseen.slice(0, MAX_RELEASES), total: unseen.length };
}

export function registerWhatsNewRoutes(app: FastifyInstance): void {
  app.get("/api/home/whats-new", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const { releases, total } = unseenReleases(user.id, user.created_at);
    return {
      version: config.version,
      stage: config.stage,
      releases: releases.map(({ version, label }) => ({ version, label })),
      total
    };
  });

  // Dismissing (or following the link) records the running version as seen.
  app.post("/api/home/whats-new/seen", { preHandler: app.authenticate }, async (request) => {
    markSeen(request.user!.id, config.version);
    return { ok: true };
  });
}
