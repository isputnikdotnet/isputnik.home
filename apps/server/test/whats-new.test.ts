import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../src/db.js";
import { VERSION_UPDATES } from "../src/changelog.js";
import { unseenReleases } from "../src/modules/home/whats-new.js";
import { makeUser, pastIso } from "./helpers/seed.js";

// Home's "Updated to X — what changed" note: once per upgrade, never for a brand-new
// account, and only the releases a person hasn't been told about.

const [current, previous, older] = VERSION_UPDATES;
const OLD_ACCOUNT = pastIso(30 * 86_400_000);
const NEW_ACCOUNT = pastIso(86_400_000);

function seen(userId: string, version: string): void {
  db.prepare("INSERT OR REPLACE INTO user_seen_versions (user_id, version) VALUES (?, ?)").run(userId, version);
}

beforeEach(() => {
  db.pragma("foreign_keys = OFF");
  db.prepare("DELETE FROM user_seen_versions").run();
  db.prepare("DELETE FROM users").run();
  db.pragma("foreign_keys = ON");
});

describe("unseenReleases", () => {
  it("tells a brand-new account nothing, and remembers it has seen this version", () => {
    const id = makeUser("fresh");
    expect(unseenReleases(id, NEW_ACCOUNT, current.version)).toEqual({ releases: [], total: 0 });
    const row = db.prepare("SELECT version FROM user_seen_versions WHERE user_id = ?").get(id) as { version: string };
    expect(row.version).toBe(current.version);
  });

  it("tells an account from before this existed about the current release only", () => {
    const id = makeUser("veteran");
    const result = unseenReleases(id, OLD_ACCOUNT, current.version);
    expect(result.releases.map((r) => r.version)).toEqual([current.version]);
  });

  it("lists every release since the one last seen, newest first", () => {
    const id = makeUser("returning");
    seen(id, older.version);
    const result = unseenReleases(id, OLD_ACCOUNT, current.version);
    expect(result.releases.map((r) => r.version)).toEqual([current.version, previous.version]);
    expect(result.total).toBe(2);
  });

  it("says nothing once the current version has been seen", () => {
    const id = makeUser("uptodate");
    seen(id, current.version);
    expect(unseenReleases(id, OLD_ACCOUNT, current.version).total).toBe(0);
  });

  it("caps the headlines at five but reports the full count", () => {
    const id = makeUser("away");
    seen(id, VERSION_UPDATES[9].version);
    const result = unseenReleases(id, OLD_ACCOUNT, current.version);
    expect(result.releases).toHaveLength(5);
    expect(result.total).toBe(9);
  });

  it("says nothing for a build whose version has no changelog entry", () => {
    const id = makeUser("dev");
    expect(unseenReleases(id, OLD_ACCOUNT, "0.0.0-dev")).toEqual({ releases: [], total: 0 });
  });
});
