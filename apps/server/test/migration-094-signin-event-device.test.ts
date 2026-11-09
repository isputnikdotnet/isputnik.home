// Migration 94 (db/migrations/094-signin-event-device.ts): a failed or refused
// password sign-in is pinned to the account whose name was typed, and the sign-in
// events gain a column for the device they came from. Run on a scratch database
// shaped as 4.74 left it, where a failure's only record of the name was its
// detail sentence.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "../src/db/migrations/094-signin-event-device.js";

const DASH = "—";

function shapedLike474() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE activity_logs (
      id TEXT PRIMARY KEY, event TEXT NOT NULL, actor_user_id TEXT, target_type TEXT, target_id TEXT,
      detail TEXT NOT NULL, ip_address TEXT, created_at TEXT NOT NULL DEFAULT '2026-11-08'
    );
    INSERT INTO users (id, email, deleted_at) VALUES
      ('lucas', 'lucas@example.test', NULL),
      ('gone', 'gone@example.test', '2026-01-01');
    INSERT INTO activity_logs (id, event, detail) VALUES
      ('f1', 'auth.login_failed', 'A sign-in attempt for Lucas@Example.test failed ${DASH} wrong password.'),
      ('f2', 'auth.login_failed', 'A sign-in attempt for nobody@example.test failed ${DASH} there is no account with that address.'),
      ('f3', 'auth.login_failed', 'A sign-in attempt for gone@example.test failed ${DASH} that account was deleted.'),
      ('l1', 'auth.login_locked', 'Sign-in refused for lucas@example.test: account temporarily locked after repeated failures.'),
      ('l2', 'auth.login_locked', 'Passkey sign-in refused for lucas@example.test: account temporarily locked after repeated failures.'),
      ('m1', 'auth.mfa_failed', 'A two-factor code was rejected.'),
      ('ok', 'auth.login', 'Signed in.');
    UPDATE activity_logs SET target_type = 'user', target_id = 'lucas' WHERE id = 'm1';
  `);
  return db;
}

function targets(db: InstanceType<typeof Database>): Record<string, string | null> {
  const rows = db.prepare("SELECT id, target_id FROM activity_logs ORDER BY id").all() as { id: string; target_id: string | null }[];
  return Object.fromEntries(rows.map((row) => [row.id, row.target_id]));
}

describe("migration 94", () => {
  it("adds the device column and pins old failures to the account whose name was typed", () => {
    const db = shapedLike474();
    db.transaction(() => up(db))();

    const columns = (db.prepare("PRAGMA table_info(activity_logs)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("user_agent");

    expect(targets(db)).toEqual({
      f1: "lucas", // matched regardless of how the address was typed
      f2: null, // no such account: stays a name that matches nobody
      f3: null, // a deleted account is no account, as the login route sees it
      l1: "lucas",
      l2: "lucas", // the passkey route's wording
      m1: "lucas", // already pinned, left alone
      ok: null
    });
    expect(db.prepare("SELECT target_type FROM activity_logs WHERE id = 'f1'").pluck().get()).toBe("user");
  });

  it("is safe to run on a database that already has the column", () => {
    const db = shapedLike474();
    db.exec("ALTER TABLE activity_logs ADD COLUMN user_agent TEXT");
    expect(() => db.transaction(() => up(db))()).not.toThrow();
    expect(targets(db).l1).toBe("lucas");
  });
});
