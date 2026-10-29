import type Database from "better-sqlite3";

// 4.46.1: the address a Stremio link was made on (docs/stremio-plan.md).
//
// A server reached by two names — one through Cloudflare, one at home — built
// every link on APP_URL, so a link made at home still sent Stremio's posters and
// streams out through Cloudflare, where the home-network rule refused them. Each
// link now keeps the origin it was created on (`https://hub.example.com`) and is
// built on that; NULL (older links, other scopes) still means APP_URL.
export const version = 85;

export function up(db: Database.Database): void {
  const columns = new Set((db.prepare("PRAGMA table_info(api_tokens)").all() as { name: string }[]).map((c) => c.name));
  if (columns.size > 0 && !columns.has("origin")) db.exec("ALTER TABLE api_tokens ADD COLUMN origin TEXT");
}
