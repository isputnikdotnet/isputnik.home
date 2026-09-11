import type Database from "better-sqlite3";

// 3.11.0 — where a flagged address sits. AbuseIPDB already returns the country
// and ISP with every check; storing them lets the Logins table say "US ·
// DigitalOcean" beside a score without a second lookup.
export const version = 40;

export function up(db: Database.Database): void {
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
