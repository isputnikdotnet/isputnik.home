import type Database from "better-sqlite3";

// 4.75: the Sign-ins page names the device and the account behind a FAILED
// attempt, which has no session to read either off. Two changes:
//  - activity_logs.user_agent (a new install gets it from schema.sql); the
//    sign-in events write the request's User-Agent into it from here on.
//  - a failed or refused password sign-in is pinned to the account whose address
//    was typed (target_type 'user'), the way a rejected two-factor code always
//    was. Rows logged before this carry the address only in their detail
//    sentence, so it is read back out and matched against the accounts; a name
//    that matches no account stays unpinned, which is what it is.
export const version = 94;

// The two sentences auth-routes / webauthn-routes wrote (failedSignInDetail and
// the locked refusal), as they were at the time of this migration.
const FAILED = /^A sign-in attempt for (.+) failed \u2014 /;
const REFUSED = /^(?:Passkey )?[Ss]ign-in refused for (.+): /;

export function up(db: Database.Database): void {
  const columns = new Set((db.prepare("PRAGMA table_info(activity_logs)").all() as { name: string }[]).map((c) => c.name));
  if (columns.size === 0) return;
  if (!columns.has("user_agent")) db.exec("ALTER TABLE activity_logs ADD COLUMN user_agent TEXT");

  const rows = db.prepare(
    "SELECT id, event, detail FROM activity_logs WHERE event IN ('auth.login_failed', 'auth.login_locked') AND target_id IS NULL"
  ).all() as { id: string; event: string; detail: string }[];
  if (rows.length === 0) return;
  // Live accounts only, as the login route pins them: a deleted account's name is
  // "a name that matches no account" from then on.
  const byEmail = new Map<string, string>();
  for (const user of db.prepare("SELECT id, email FROM users WHERE deleted_at IS NULL").all() as { id: string; email: string }[]) {
    byEmail.set(user.email.toLowerCase(), user.id);
  }
  const pin = db.prepare("UPDATE activity_logs SET target_type = 'user', target_id = ? WHERE id = ?");
  for (const row of rows) {
    const email = (row.event === "auth.login_failed" ? FAILED : REFUSED).exec(row.detail)?.[1]?.toLowerCase();
    const userId = email ? byEmail.get(email) : undefined;
    if (userId) pin.run(userId, row.id);
  }
}
